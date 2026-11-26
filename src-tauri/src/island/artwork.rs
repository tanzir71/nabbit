//! Media producers supply local PNG thumbnail data, never a remote fetch from the renderer.
use base64::Engine;
pub struct Pixels {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}
pub fn decode(value: &str) -> Option<Pixels> {
    let encoded = value.strip_prefix("data:image/png;base64,")?;
    if encoded.len() > 4 * 1024 * 1024 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if width == 0 || height == 0 || width > 1024 || height > 1024 {
        return None;
    }
    let image = tauri::image::Image::from_bytes(&bytes).ok()?;
    if image.width() != width || image.height() != height {
        return None;
    }
    let mut rgba = image.rgba().to_vec();
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = pixel[3] as u16;
        for channel in &mut pixel[..3] {
            *channel = ((*channel as u16 * alpha + 127) / 255) as u8;
        }
    }
    Some(Pixels {
        rgba,
        width,
        height,
    })
}
