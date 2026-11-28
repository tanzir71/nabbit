//! Windows clipboard reads hold one lock: privacy formats precede all payloads.
use crate::{
    db::Database,
    error::{msg, Result},
};
pub enum Payload {
    Text(String),
    Image(Vec<u8>),
    Files(Vec<String>),
}
pub struct Read {
    pub source: Option<String>,
    pub payload: Payload,
}
pub fn ingest(db: &Database, read: Read) -> Result<Option<crate::db::models::ClipboardEntry>> {
    match read.payload {
        Payload::Text(text) => db.add_clipboard_text(&text, read.source),
        Payload::Image(bytes) => db.add_clipboard_image(&bytes, read.source),
        Payload::Files(paths) => db.add_clipboard_files(paths, read.source),
    }
}
/// CF_DIB has no BITMAPFILEHEADER. Construct one only after validating its
/// dimensions, palette/masks, compression and complete bounded pixel extent.
pub(crate) fn dib_bmp(dib: &[u8]) -> Result<Vec<u8>> {
    let u32_at = |n| {
        dib.get(n..n + 4)
            .and_then(|v| v.try_into().ok())
            .map(u32::from_le_bytes)
            .ok_or_else(|| msg("Copied bitmap header is incomplete"))
    };
    let header = u32_at(0)? as usize;
    if ![40, 108, 124].contains(&header) || dib.len() < header {
        return Err(msg("Unsupported copied bitmap header"));
    }
    let width = u32_at(4)? as i32;
    let height = u32_at(8)? as i32;
    let h = height
        .checked_abs()
        .ok_or_else(|| msg("Invalid copied bitmap height"))? as u64;
    let bits = u16::from_le_bytes(dib[14..16].try_into().unwrap());
    let compression = u32_at(16)?;
    let colours = u32_at(32)? as usize;
    if width <= 0
        || width > 20000
        || h == 0
        || h > 20000
        || (width as u64) * h > 64_000_000
        || dib[12..14] != 1u16.to_le_bytes()
        || ![1, 4, 8, 16, 24, 32].contains(&bits)
        || ![0, 3].contains(&compression)
        || (compression == 3 && ![16, 32].contains(&bits))
    {
        return Err(msg("Copied bitmap exceeds supported limits"));
    }
    if header == 124 && (u32_at(112)? != 0 || u32_at(116)? != 0) {
        return Err(msg(
            "Copied bitmap uses an unsupported embedded profile; copy as PNG",
        ));
    }
    let palette = if bits <= 8 {
        if colours == 0 {
            1usize << bits
        } else if colours <= 1usize << bits {
            colours
        } else {
            return Err(msg("Invalid copied bitmap palette"));
        }
    } else {
        colours
    };
    if palette > 256 {
        return Err(msg("Invalid copied bitmap palette"));
    }
    let offset = header
        + palette * 4
        + if header == 40 && compression == 3 {
            12
        } else {
            0
        };
    let stride = ((width as u64) * u64::from(bits)).div_ceil(32) * 4;
    let end = (offset as u64) + stride * h;
    if end > dib.len() as u64 || dib.len() > 128 * 1024 * 1024 {
        return Err(msg("Copied bitmap pixels are incomplete or too large"));
    }
    let mut bmp = Vec::with_capacity(dib.len() + 14);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&((dib.len() + 14) as u32).to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&((offset + 14) as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    Ok(bmp)
}
#[cfg(windows)]
pub(crate) fn privacy_locked() -> Result<super::classify::Privacy> {
    use clipboard_win::{is_format_avail, raw, register_format};
    let permission = |name: &str| -> Result<Option<u32>> {
        let format =
            register_format(name).ok_or_else(|| msg("Clipboard privacy status is unavailable"))?;
        if !is_format_avail(format.get()) {
            return Ok(None);
        }
        let mut bytes = [0u8; 4];
        if raw::size(format.get()).is_none_or(|n| n.get() < 4)
            || raw::get(format.get(), &mut bytes).is_err()
        {
            return Ok(Some(0));
        }
        Ok(Some(u32::from_le_bytes(bytes)))
    };
    let format = register_format("ExcludeClipboardContentFromMonitorProcessing")
        .ok_or_else(|| msg("Clipboard privacy status is unavailable"))?;
    Ok(super::classify::Privacy {
        excluded: is_format_avail(format.get()),
        history: permission("CanIncludeInClipboardHistory")?,
        cloud: permission("CanUploadToCloudClipboard")?,
        excluded_app: false,
    })
}
#[cfg(windows)]
pub fn read(db: &Database) -> Result<Option<Read>> {
    use clipboard_win::{formats, is_format_avail, raw, register_format};
    let _lock = clipboard_win::Clipboard::new().map_err(|_| msg("Clipboard is busy"))?;
    if privacy_locked()?.blocked() {
        return Ok(None);
    }
    let source = source_app();
    if source.is_none() || !db.clipboard_source_allowed(source.as_deref())? {
        return Ok(None);
    }
    let payload = if is_format_avail(formats::CF_HDROP) {
        if raw::size(formats::CF_HDROP).is_none_or(|n| n.get() > 8 * 1024 * 1024) {
            return Ok(None);
        }
        let mut files = Vec::new();
        raw::get_file_list(&mut files).map_err(|_| msg("Copied files are unavailable"))?;
        Payload::Files(files)
    } else if db.get_settings()?.capture_images
        && (is_format_avail(formats::CF_DIBV5)
            || is_format_avail(formats::CF_DIB)
            || register_format("PNG").is_some_and(|f| is_format_avail(f.get())))
    {
        let png = register_format("PNG").filter(|f| is_format_avail(f.get()));
        let format = png.map(|f| f.get()).unwrap_or_else(|| {
            if is_format_avail(formats::CF_DIBV5) {
                formats::CF_DIBV5
            } else {
                formats::CF_DIB
            }
        });
        if raw::size(format).is_none_or(|n| n.get() > 128 * 1024 * 1024) {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        raw::get_vec(format, &mut bytes).map_err(|_| msg("Copied image is unavailable"))?;
        Payload::Image(if png.is_some() {
            bytes
        } else {
            dib_bmp(&bytes)?
        })
    } else if is_format_avail(formats::CF_UNICODETEXT) {
        if raw::size(formats::CF_UNICODETEXT).is_none_or(|n| n.get() > 4_000_002) {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        raw::get_string(&mut bytes).map_err(|_| msg("Copied text is unavailable"))?;
        Payload::Text(String::from_utf8(bytes).map_err(|_| msg("Copied text is not UTF-8"))?)
    } else {
        return Ok(None);
    };
    Ok(Some(Read { source, payload }))
}
#[cfg(windows)]
pub(crate) fn source_app() -> Option<String> {
    use windows_sys::Win32::{System::DataExchange::GetClipboardOwner, UI::WindowsAndMessaging::*};
    let pid = unsafe {
        let owner = GetClipboardOwner();
        let window = if owner.is_null() {
            GetForegroundWindow()
        } else {
            owner
        };
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        pid
    };
    process_name(pid)
}
#[cfg(windows)]
pub(crate) fn process_name(pid: u32) -> Option<String> {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut path = vec![0u16; 32768];
        let mut size = path.len() as u32;
        let got = QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut size);
        CloseHandle(handle);
        if got == 0 {
            return None;
        }
        std::path::Path::new(&String::from_utf16_lossy(&path[..size as usize]))
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dib_conversion_checks_extent_orientation_and_allocation_before_decode() {
        let mut dib = vec![0; 40 + 24];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&3i32.to_le_bytes());
        dib[8..12].copy_from_slice(&(-2i32).to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        let image = image::load_from_memory(&dib_bmp(&dib).unwrap()).unwrap();
        assert_eq!((image.width(), image.height()), (3, 2));
        assert!(dib_bmp(&dib[..50]).is_err());
        dib[4..8].copy_from_slice(&i32::MAX.to_le_bytes());
        assert!(dib_bmp(&dib).is_err());
    }
}
