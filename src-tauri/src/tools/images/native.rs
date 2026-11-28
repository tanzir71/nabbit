use crate::error::{msg, Result};
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub pixels: Option<Vec<u8>>,
}
#[cfg(windows)]
pub fn decode(bytes: &[u8], pixels: bool) -> Result<Bitmap> {
    use windows::{Graphics::Imaging::*, Storage::Streams::*};
    let _apartment = crate::tools::platform::Apartment::new()?;
    let stream = crate::tools::platform::stream(bytes)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .and_then(|a| a.join())
        .map_err(|e| msg(format!("Windows image decoder unavailable: {e}")))?;
    let width = decoder
        .OrientedPixelWidth()
        .map_err(|e| msg(e.to_string()))?;
    let height = decoder
        .OrientedPixelHeight()
        .map_err(|e| msg(e.to_string()))?;
    super::dimensions(width, height)?;
    let data = if pixels {
        let transform = BitmapTransform::new().map_err(|e| msg(e.to_string()))?;
        let bitmap = decoder
            .GetSoftwareBitmapTransformedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Straight,
                &transform,
                ExifOrientationMode::RespectExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )
            .and_then(|a| a.join())
            .map_err(|e| msg(e.to_string()))?;
        let count = width
            .checked_mul(height)
            .and_then(|v| v.checked_mul(4))
            .ok_or_else(|| msg("Image size overflow"))?;
        let buffer = Buffer::Create(count).map_err(|e| msg(e.to_string()))?;
        buffer.SetLength(count).map_err(|e| msg(e.to_string()))?;
        bitmap
            .CopyToBuffer(&buffer)
            .map_err(|e| msg(e.to_string()))?;
        let reader = DataReader::FromBuffer(&buffer).map_err(|e| msg(e.to_string()))?;
        let mut rgba = vec![0; count as usize];
        reader
            .ReadBytes(&mut rgba)
            .map_err(|e| msg(e.to_string()))?;
        for pixel in rgba.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        bitmap.Close().map_err(|e| msg(e.to_string()))?;
        Some(rgba)
    } else {
        None
    };
    Ok(Bitmap {
        width,
        height,
        pixels: data,
    })
}
#[cfg(not(windows))]
pub fn decode(_bytes: &[u8], _pixels: bool) -> Result<Bitmap> {
    Err(msg("Windows image codecs are unavailable on this platform"))
}
