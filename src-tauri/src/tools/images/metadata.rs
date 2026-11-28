use crate::error::{msg, Result};
use img_parts::{DynImage, ImageEXIF, ImageICC};
#[derive(Clone, Debug, Default)]
pub struct Metadata {
    pub exif: Option<Vec<u8>>,
    pub icc: Option<Vec<u8>>,
}
pub fn read(raw: &[u8]) -> Result<Metadata> {
    if let Some(parts) =
        DynImage::from_bytes(raw.to_vec().into()).map_err(|e| msg(e.to_string()))?
    {
        return Ok(Metadata {
            exif: parts.exif().map(|b| b.to_vec()),
            icc: parts.icc_profile().map(|b| b.to_vec()),
        });
    }
    super::bmff::metadata(raw)
}
fn tiff(raw: &[u8]) -> Option<(&[u8], usize, bool)> {
    let start = if raw.starts_with(b"Exif\0\0") { 6 } else { 0 };
    let bytes = raw.get(start..)?;
    let le = match bytes.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    Some((bytes, start, le))
}
fn u16_at(b: &[u8], p: usize, le: bool) -> Option<u16> {
    let a = b.get(p..p.checked_add(2)?)?.try_into().ok()?;
    Some(if le {
        u16::from_le_bytes(a)
    } else {
        u16::from_be_bytes(a)
    })
}
fn u32_at(b: &[u8], p: usize, le: bool) -> Option<u32> {
    let a = b.get(p..p.checked_add(4)?)?.try_into().ok()?;
    Some(if le {
        u32::from_le_bytes(a)
    } else {
        u32::from_be_bytes(a)
    })
}
pub fn orientation(exif: Option<&[u8]>) -> u8 {
    let Some((b, _, le)) = exif.and_then(tiff) else {
        return 1;
    };
    let Some(pos) = u32_at(b, 4, le).map(|p| p as usize) else {
        return 1;
    };
    let count = u16_at(b, pos, le).unwrap_or(0).min(4096) as usize;
    for n in 0..count {
        let at = pos + 2 + n * 12;
        if u16_at(b, at, le) == Some(0x112)
            && u16_at(b, at + 2, le) == Some(3)
            && u32_at(b, at + 4, le) == Some(1)
        {
            return u16_at(b, at + 8, le)
                .filter(|v| (1..=8).contains(v))
                .unwrap_or(1) as u8;
        }
    }
    1
}
/// Change only display geometry tags; keep capture dates, camera data and GPS.
pub fn upright(exif: &[u8], width: u32, height: u32) -> Vec<u8> {
    let Some((b, start, le)) = tiff(exif) else {
        return exif.to_vec();
    };
    let mut out = exif.to_vec();
    let mut dirs = vec![u32_at(b, 4, le).unwrap_or(0) as usize];
    for _ in 0..4 {
        let Some(pos) = dirs.pop() else { break };
        if pos < 8 {
            continue;
        }
        for n in 0..usize::from(u16_at(b, pos, le).unwrap_or(0).min(4096)) {
            let at = pos + 2 + n * 12;
            let (Some(tag), Some(kind), Some(count)) = (
                u16_at(b, at, le),
                u16_at(b, at + 2, le),
                u32_at(b, at + 4, le),
            ) else {
                break;
            };
            if tag == 0x8769 {
                if let Some(p) = u32_at(b, at + 8, le) {
                    dirs.push(p as usize);
                }
                continue;
            }
            let value = match tag {
                0x112 => Some(1),
                0x100 | 0xA002 => Some(width),
                0x101 | 0xA003 => Some(height),
                _ => None,
            };
            if let Some(value) = value.filter(|_| count == 1) {
                let p = start + at + 8;
                match kind {
                    3 if value <= u16::MAX.into() => {
                        if let Some(dst) = out.get_mut(p..p + 2) {
                            dst.copy_from_slice(&if le {
                                (value as u16).to_le_bytes()
                            } else {
                                (value as u16).to_be_bytes()
                            });
                        }
                    }
                    4 => {
                        if let Some(dst) = out.get_mut(p..p + 4) {
                            dst.copy_from_slice(&if le {
                                value.to_le_bytes()
                            } else {
                                value.to_be_bytes()
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}
fn display_exif(orientation: u8) -> Option<Vec<u8>> {
    if orientation == 1 {
        return None;
    }
    let mut t = b"II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x01\0\0\0\0\0\0\0".to_vec();
    t[18] = orientation;
    Some(t)
}
pub fn attach(raw: Vec<u8>, meta: &Metadata) -> Result<Vec<u8>> {
    let Some(mut parts) = DynImage::from_bytes(raw.into()).map_err(|e| msg(e.to_string()))? else {
        return Err(msg(
            "This image container does not support this metadata operation",
        ));
    };
    if matches!(parts, DynImage::Jpeg(_)) && meta.exif.as_ref().is_some_and(|v| v.len() > 65527) {
        return Err(msg(
            "The EXIF block is too large for JPG. Choose PNG or remove location and camera data.",
        ));
    }
    parts.set_exif(meta.exif.clone().map(Into::into));
    parts.set_icc_profile(meta.icc.clone().map(Into::into));
    Ok(parts.encoder().bytes().to_vec())
}
/// Keep encoded pixels/colour chunks and a minimal display-only orientation.
pub fn strip(raw: Vec<u8>, keep_profile: bool) -> Result<Vec<u8>> {
    let meta = read(&raw)?;
    let orient = orientation(meta.exif.as_deref());
    let Some(mut parts) = DynImage::from_bytes(raw.into()).map_err(|e| msg(e.to_string()))? else {
        return Err(msg("Lossless metadata removal supports JPG, PNG and WebP"));
    };
    match &mut parts {
        DynImage::Jpeg(j) => j.segments_mut().retain(|s| {
            let m = s.marker();
            (!(0xE0..=0xEF).contains(&m) && m != 0xFE)
                || (m == 0xE0 && s.contents().starts_with(b"JFIF\0") && s.contents().len() == 14)
                || m == 0xEE
        }),
        DynImage::Png(p) => p.chunks_mut().retain(|c| {
            let k = c.kind();
            k[0] & 0x20 == 0
                || [
                    *b"gAMA", *b"cHRM", *b"sRGB", *b"iCCP", *b"tRNS", *b"sBIT", *b"cICP", *b"cLLi",
                    *b"mDCv", *b"acTL", *b"fcTL", *b"fdAT",
                ]
                .contains(&k)
        }),
        DynImage::WebP(w) => w.chunks_mut().retain(|c| {
            [
                *b"VP8 ", *b"VP8L", *b"VP8X", *b"ALPH", *b"ANIM", *b"ANMF", *b"ICCP",
            ]
            .contains(&c.id())
        }),
    }
    parts.set_exif(display_exif(orient).map(Into::into));
    parts.set_icc_profile(if keep_profile {
        meta.icc.map(Into::into)
    } else {
        None
    });
    Ok(parts.encoder().bytes().to_vec())
}

/// Decoders expand pixels to RGB(A); a CMYK/gray tag cannot describe those pixels.
pub fn validate_rgb_profile(meta: &Metadata) -> Result<()> {
    if meta
        .icc
        .as_ref()
        .is_some_and(|icc| icc.get(36..40) == Some(b"acsp") && icc.get(16..20) != Some(b"RGB "))
    {
        return Err(msg(
            "This colour profile needs colour-managed conversion. Export an sRGB copy first.",
        ));
    }
    Ok(())
}
