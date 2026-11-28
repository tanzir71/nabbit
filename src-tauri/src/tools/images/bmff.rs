//! Bounded HEIF/AVIF container metadata; image decoding stays in WIC/ffmpeg.
use super::metadata::Metadata;
use crate::error::{msg, Result};
#[derive(Clone, Copy)]
struct BoxRef {
    start: usize,
    data: usize,
    end: usize,
    kind: [u8; 4],
}
fn boxes(raw: &[u8], mut p: usize, end: usize) -> Result<Vec<BoxRef>> {
    let mut out = Vec::new();
    while p < end {
        if out.len() >= 4096 {
            return Err(msg("Too many image container boxes"));
        }
        let len = u32::from_be_bytes(
            raw.get(p..p + 4)
                .ok_or_else(|| msg("Truncated image box"))?
                .try_into()
                .unwrap(),
        );
        let kind = raw
            .get(p + 4..p + 8)
            .ok_or_else(|| msg("Truncated image box"))?
            .try_into()
            .unwrap();
        let (len, header) = if len == 1 {
            (
                u64::from_be_bytes(
                    raw.get(p + 8..p + 16)
                        .ok_or_else(|| msg("Truncated image box"))?
                        .try_into()
                        .unwrap(),
                ),
                16,
            )
        } else {
            (
                if len == 0 {
                    (end - p) as u64
                } else {
                    u64::from(len)
                },
                8,
            )
        };
        let len = usize::try_from(len).map_err(|_| msg("Image box too large"))?;
        let next = p
            .checked_add(len)
            .filter(|n| *n <= end && len >= header)
            .ok_or_else(|| msg("Invalid image box length"))?;
        out.push(BoxRef {
            start: p,
            data: p + header,
            end: next,
            kind,
        });
        p = next;
    }
    Ok(out)
}
fn find(raw: &[u8], p: usize, end: usize, kind: [u8; 4]) -> Result<Option<BoxRef>> {
    Ok(boxes(raw, p, end)?.into_iter().find(|b| b.kind == kind))
}
fn integer(raw: &[u8], p: &mut usize, n: usize) -> Result<u64> {
    if n > 8 {
        return Err(msg("Unsupported image offset width"));
    }
    let bytes = raw
        .get(
            *p..p
                .checked_add(n)
                .ok_or_else(|| msg("Image offset overflow"))?,
        )
        .ok_or_else(|| msg("Truncated image offsets"))?;
    *p += n;
    Ok(bytes.iter().fold(0, |v, b| (v << 8) | u64::from(*b)))
}
struct Extent {
    offset: u64,
    len: u64,
    field: usize,
    field_len: usize,
}
struct Location {
    id: u64,
    method: u64,
    base: u64,
    base_field: usize,
    base_len: usize,
    extents: Vec<Extent>,
}
fn locations(raw: &[u8], b: BoxRef) -> Result<Vec<Location>> {
    let version = *raw.get(b.data).ok_or_else(|| msg("Truncated iloc"))?;
    if version > 2 {
        return Err(msg("Unsupported image location version"));
    }
    let mut p = b.data + 4;
    let sizes = integer(raw, &mut p, 1)?;
    let more = integer(raw, &mut p, 1)?;
    let offset = (sizes >> 4) as usize;
    let length = (sizes & 15) as usize;
    let base_len = (more >> 4) as usize;
    let index = if version == 0 {
        0
    } else {
        (more & 15) as usize
    };
    let count = integer(raw, &mut p, if version == 2 { 4 } else { 2 })?;
    if count > 4096 {
        return Err(msg("Too many image items"));
    }
    let mut out = Vec::new();
    for _ in 0..count {
        let id = integer(raw, &mut p, if version == 2 { 4 } else { 2 })?;
        let method = if version == 0 {
            0
        } else {
            integer(raw, &mut p, 2)? & 15
        };
        if integer(raw, &mut p, 2)? != 0 {
            return Err(msg("External image data references are unsupported"));
        }
        let base_field = p;
        let base = integer(raw, &mut p, base_len)?;
        let count = integer(raw, &mut p, 2)?;
        if count > 4096 {
            return Err(msg("Too many image extents"));
        }
        let mut extents = Vec::new();
        for _ in 0..count {
            integer(raw, &mut p, index)?;
            let field = p;
            let at = integer(raw, &mut p, offset)?;
            let len = integer(raw, &mut p, length)?;
            extents.push(Extent {
                offset: at,
                len,
                field,
                field_len: offset,
            });
        }
        out.push(Location {
            id,
            method,
            base,
            base_field,
            base_len,
            extents,
        });
    }
    if p > b.end {
        return Err(msg("Image locations exceed their box"));
    }
    Ok(out)
}
/// Validate all declared image extents before invoking a native decoder. The
/// pinned ffmpeg decodes HEIC grids as a single tile, so never offer that path.
pub fn fallback_safe(raw: &[u8]) -> Result<()> {
    let meta =
        find(raw, 0, raw.len(), *b"meta")?.ok_or_else(|| msg("Image metadata is missing"))?;
    let children = boxes(raw, meta.data + 4, meta.end)?;
    if let Some(iinf) = children.iter().find(|b| b.kind == *b"iinf") {
        let version = *raw
            .get(iinf.data)
            .ok_or_else(|| msg("Truncated image items"))?;
        for item in boxes(
            raw,
            iinf.data + 4 + if version == 0 { 2 } else { 4 },
            iinf.end,
        )? {
            let version = *raw
                .get(item.data)
                .ok_or_else(|| msg("Truncated image item"))?;
            let kind = item.data + 4 + if version == 2 { 2 } else { 4 } + 2;
            if item.kind == *b"infe" && raw.get(kind..kind + 4) == Some(b"grid") {
                return Err(msg(
                    "The bundled ffmpeg cannot decode HEIC tile grids completely",
                ));
            }
        }
    }
    let iprp = children
        .iter()
        .find(|b| b.kind == *b"iprp")
        .ok_or_else(|| msg("Image properties are missing"))?;
    let ipco = find(raw, iprp.data, iprp.end, *b"ipco")?
        .ok_or_else(|| msg("Image properties are missing"))?;
    let mut dimensions_found = false;
    for property in boxes(raw, ipco.data, ipco.end)? {
        if property.kind == *b"ispe" {
            let mut p = property.data + 4;
            let width = integer(raw, &mut p, 4)? as u32;
            let height = integer(raw, &mut p, 4)? as u32;
            if p > property.end {
                return Err(msg("Truncated image dimensions"));
            }
            super::dimensions(width, height)?;
            dimensions_found = true;
        }
    }
    if !dimensions_found {
        return Err(msg("Image dimensions are missing"));
    }
    Ok(())
}
fn primary(raw: &[u8], meta: BoxRef) -> Result<u64> {
    let item = find(raw, meta.data + 4, meta.end, *b"pitm")?
        .ok_or_else(|| msg("Primary image is missing"))?;
    let version = *raw
        .get(item.data)
        .ok_or_else(|| msg("Truncated primary image"))?;
    let mut p = item.data + 4;
    integer(raw, &mut p, if version == 0 { 2 } else { 4 })
}
fn properties(raw: &[u8], meta: BoxRef) -> Result<Vec<BoxRef>> {
    let primary = primary(raw, meta)?;
    let Some(iprp) = find(raw, meta.data + 4, meta.end, *b"iprp")? else {
        return Ok(vec![]);
    };
    let Some(ipco) = find(raw, iprp.data, iprp.end, *b"ipco")? else {
        return Ok(vec![]);
    };
    let all = boxes(raw, ipco.data, ipco.end)?;
    let ipma = find(raw, iprp.data, iprp.end, *b"ipma")?
        .ok_or_else(|| msg("Image property associations are missing"))?;
    let mut p = ipma.data;
    let flags = integer(raw, &mut p, 4)?;
    let version = flags >> 24;
    let wide = flags & 1 != 0;
    let count = integer(raw, &mut p, 4)?;
    if count > 4096 {
        return Err(msg("Too many image associations"));
    }
    let mut selected = Vec::new();
    for _ in 0..count {
        let id = integer(raw, &mut p, if version == 0 { 2 } else { 4 })?;
        let associations = integer(raw, &mut p, 1)?;
        for _ in 0..associations {
            let index =
                integer(raw, &mut p, if wide { 2 } else { 1 })? & if wide { 0x7fff } else { 0x7f };
            if id == primary && index > 0 {
                selected.push(
                    *all.get(index as usize - 1)
                        .ok_or_else(|| msg("Invalid image property index"))?,
                );
            }
        }
    }
    if p > ipma.end {
        return Err(msg("Truncated image associations"));
    }
    Ok(selected)
}
pub fn container_transform(raw: &[u8]) -> Result<bool> {
    let meta =
        find(raw, 0, raw.len(), *b"meta")?.ok_or_else(|| msg("Image metadata is missing"))?;
    Ok(properties(raw, meta)?
        .iter()
        .any(|b| matches!(&b.kind, b"irot" | b"imir")))
}
pub fn metadata(raw: &[u8]) -> Result<Metadata> {
    if raw.get(4..8) != Some(b"ftyp") {
        return Ok(Metadata::default());
    }
    let Some(meta) = find(raw, 0, raw.len(), *b"meta")? else {
        return Ok(Metadata::default());
    };
    if meta.end - meta.data > 16 * 1024 * 1024 {
        return Err(msg("Image metadata is too large"));
    }
    let children = boxes(raw, meta.data + 4, meta.end)?;
    let mut exif_ids = Vec::new();
    if let Some(iinf) = children.iter().find(|b| b.kind == *b"iinf") {
        let count_len = if *raw
            .get(iinf.data)
            .ok_or_else(|| msg("Truncated image item list"))?
            == 0
        {
            2
        } else {
            4
        };
        for infe in boxes(raw, iinf.data + 4 + count_len, iinf.end)? {
            if infe.kind != *b"infe" {
                continue;
            }
            let version = *raw
                .get(infe.data)
                .ok_or_else(|| msg("Truncated image item"))?;
            let mut p = infe.data + 4;
            if !(2..=3).contains(&version) {
                continue;
            }
            let id = integer(raw, &mut p, if version == 2 { 2 } else { 4 })?;
            integer(raw, &mut p, 2)?;
            if raw.get(p..p + 4) == Some(b"Exif") {
                exif_ids.push(id);
            }
        }
    }
    let mut exif_id = if exif_ids.len() == 1 {
        Some(exif_ids[0])
    } else {
        None
    };
    if let Some(iref) = children.iter().find(|b| b.kind == *b"iref") {
        let version = *raw
            .get(iref.data)
            .ok_or_else(|| msg("Truncated image references"))?;
        let target = primary(raw, meta)?;
        exif_id = None;
        for reference in boxes(raw, iref.data + 4, iref.end)? {
            if reference.kind != *b"cdsc" {
                continue;
            }
            let mut p = reference.data;
            let width = if version == 0 { 2 } else { 4 };
            let from = integer(raw, &mut p, width)?;
            let count = integer(raw, &mut p, 2)?;
            if count > 4096 {
                return Err(msg("Too many image references"));
            }
            for _ in 0..count {
                let to = integer(raw, &mut p, width)?;
                if to == target && exif_ids.contains(&from) {
                    exif_id = Some(from);
                }
            }
            if p > reference.end {
                return Err(msg("Truncated image reference"));
            }
        }
    }
    let mut result = Metadata::default();
    if let (Some(id), Some(iloc)) = (exif_id, children.iter().find(|b| b.kind == *b"iloc")) {
        if let Some(loc) = locations(raw, *iloc)?.into_iter().find(|l| l.id == id) {
            let idat = children
                .iter()
                .find(|b| b.kind == *b"idat")
                .map(|b| b.data as u64);
            let mut bytes = Vec::new();
            for e in loc.extents {
                if bytes.len() as u64 + e.len > 2 * 1024 * 1024 {
                    return Err(msg("EXIF metadata is too large"));
                }
                let start = match loc.method {
                    0 => Some(0),
                    1 => idat,
                    _ => None,
                }
                .and_then(|b| b.checked_add(loc.base))
                .and_then(|b| b.checked_add(e.offset))
                .ok_or_else(|| msg("Unsupported EXIF data location"))?;
                let end = start
                    .checked_add(e.len)
                    .ok_or_else(|| msg("EXIF extent overflow"))?;
                let data = raw
                    .get(
                        usize::try_from(start).unwrap_or(usize::MAX)
                            ..usize::try_from(end).unwrap_or(usize::MAX),
                    )
                    .ok_or_else(|| msg("EXIF extent is outside the file"))?;
                bytes.extend_from_slice(data);
            }
            if bytes.len() >= 4 {
                let offset = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
                let begin = 4usize
                    .checked_add(offset)
                    .ok_or_else(|| msg("Invalid EXIF offset"))?;
                result.exif = Some(
                    bytes
                        .get(begin..)
                        .ok_or_else(|| msg("Invalid EXIF header"))?
                        .to_vec(),
                );
            }
        }
    }
    for b in properties(raw, meta)? {
        if b.kind == *b"colr"
            && [b"prof", b"rICC"]
                .iter()
                .any(|k| raw.get(b.data..b.data + 4) == Some(k.as_slice()))
        {
            if b.end - b.data > 2 * 1024 * 1024 {
                return Err(msg("ICC profile is too large"));
            }
            result.icc = Some(raw[b.data + 4..b.end].to_vec());
            break;
        }
    }
    Ok(result)
}
fn put_integer(raw: &mut [u8], p: usize, n: usize, value: u64) -> Result<()> {
    if n == 0 || n > 8 || (n < 8 && value >= (1u64 << (n * 8))) {
        return Err(msg("Image metadata offset cannot be represented"));
    }
    raw.get_mut(p..p + n)
        .ok_or_else(|| msg("Invalid image metadata offset"))?
        .copy_from_slice(&value.to_be_bytes()[8 - n..]);
    Ok(())
}
/// The ravif writer uses absolute iloc extents; update them after adding ICC.
pub fn with_icc(mut raw: Vec<u8>, icc: &[u8]) -> Result<Vec<u8>> {
    if icc.len() > 2 * 1024 * 1024 {
        return Err(msg("ICC profile is too large"));
    }
    let meta =
        find(&raw, 0, raw.len(), *b"meta")?.ok_or_else(|| msg("AVIF metadata is missing"))?;
    let iprp = find(&raw, meta.data + 4, meta.end, *b"iprp")?
        .ok_or_else(|| msg("AVIF properties are missing"))?;
    let ipco = find(&raw, iprp.data, iprp.end, *b"ipco")?
        .ok_or_else(|| msg("AVIF colour properties are missing"))?;
    let existing = find(&raw, ipco.data, ipco.end, *b"colr")?;
    let colr = existing.unwrap_or(BoxRef {
        start: ipco.end,
        data: ipco.end,
        end: ipco.end,
        kind: *b"colr",
    });
    let mut association = None;
    if existing.is_none() {
        let index = boxes(&raw, ipco.data, ipco.end)?.len() + 1;
        if index > 127 {
            return Err(msg("Too many AVIF properties"));
        }
        let pitm = find(&raw, meta.data + 4, meta.end, *b"pitm")?
            .ok_or_else(|| msg("AVIF primary item is missing"))?;
        let mut p = pitm.data + 4;
        let primary = integer(&raw, &mut p, if raw[pitm.data] == 0 { 2 } else { 4 })?;
        let ipma = find(&raw, iprp.data, iprp.end, *b"ipma")?
            .ok_or_else(|| msg("AVIF associations are missing"))?;
        if raw.get(ipma.data..ipma.data + 4) != Some(&[0, 0, 0, 0]) {
            return Err(msg("Unsupported encoded AVIF associations"));
        }
        let mut p = ipma.data + 4;
        let count = integer(&raw, &mut p, 4)?;
        if count > 4096 {
            return Err(msg("Too many AVIF associations"));
        }
        for _ in 0..count {
            let id = integer(&raw, &mut p, 2)?;
            let count_at = p;
            let n = integer(&raw, &mut p, 1)? as usize;
            p = p
                .checked_add(n)
                .filter(|p| *p <= ipma.end)
                .ok_or_else(|| msg("Truncated AVIF associations"))?;
            if id == primary {
                if n >= 255 {
                    return Err(msg("Too many primary properties"));
                }
                raw[count_at] = (n + 1) as u8;
                put_integer(&mut raw, ipma.start, 4, (ipma.end - ipma.start + 1) as u64)?;
                association = Some((p, index as u8));
                break;
            }
        }
        if association.is_none() {
            return Err(msg("AVIF primary properties are missing"));
        }
    }
    let size = 12 + icc.len();
    let property_delta = size as i64 - (colr.end - colr.start) as i64;
    let delta = property_delta + i64::from(association.is_some());
    let iloc = find(&raw, meta.data + 4, meta.end, *b"iloc")?
        .ok_or_else(|| msg("AVIF locations are missing"))?;
    for loc in locations(&raw, iloc)? {
        if loc.method != 0 {
            return Err(msg("Unsupported encoded AVIF metadata layout"));
        }
        if loc.base >= meta.end as u64 {
            put_integer(
                &mut raw,
                loc.base_field,
                loc.base_len,
                loc.base
                    .checked_add_signed(delta)
                    .ok_or_else(|| msg("AVIF offset overflow"))?,
            )?;
        } else {
            for e in loc.extents {
                if loc.base + e.offset >= meta.end as u64 {
                    put_integer(
                        &mut raw,
                        e.field,
                        e.field_len,
                        e.offset
                            .checked_add_signed(delta)
                            .ok_or_else(|| msg("AVIF offset overflow"))?,
                    )?;
                }
            }
        }
    }
    for b in [meta, iprp, ipco] {
        if b.data != b.start + 8 {
            return Err(msg("Unsupported large AVIF metadata box"));
        }
        let len = (b.end - b.start) as u64;
        put_integer(
            &mut raw,
            b.start,
            4,
            len.checked_add_signed(if b.kind == *b"ipco" {
                property_delta
            } else {
                delta
            })
            .ok_or_else(|| msg("AVIF size overflow"))?,
        )?;
    }
    let mut replacement = Vec::with_capacity(size);
    replacement.extend_from_slice(&(size as u32).to_be_bytes());
    replacement.extend_from_slice(b"colrprof");
    replacement.extend_from_slice(icc);
    if let Some((at, index)) = association {
        raw.insert(at, index);
    }
    raw.splice(colr.start..colr.end, replacement);
    Ok(raw)
}
