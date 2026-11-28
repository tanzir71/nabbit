use crate::error::{msg, Result};
#[cfg(windows)]
pub fn render(raw: &[u8], page: u32) -> Result<Vec<u8>> {
    use windows::{
        core::Interface,
        Data::Pdf::PdfDocument,
        Win32::{
            Foundation::{HMODULE, POINT},
            Graphics::{
                Direct2D::Common::*,
                Direct3D::D3D_DRIVER_TYPE_WARP,
                Direct3D11::*,
                Dxgi::{Common::*, IDXGIDevice, IDXGISurface},
            },
            System::WinRT::Pdf::*,
        },
    };
    let _apartment = super::super::platform::Apartment::new()?;
    let stream = super::super::platform::stream(raw)?;
    let document = PdfDocument::LoadFromStreamAsync(&stream)
        .and_then(|a| a.join())
        .map_err(|e| msg(format!("Windows could not read PDF: {e}")))?;
    if page == 0 || page > document.PageCount().map_err(|e| msg(e.to_string()))? {
        return Err(msg("Page range is outside this PDF"));
    }
    let page = document.GetPage(page - 1).map_err(|e| msg(e.to_string()))?;
    let size = page.Size().map_err(|e| msg(e.to_string()))?;
    // WinRT Size uses 96-DPI DIPs. 1.5 produces 144-DPI PNGs.
    let (width, height) = (
        (size.Width * 1.5).round() as u32,
        (size.Height * 1.5).round() as u32,
    );
    super::images::dimensions(width, height)?;
    // Explicit WARP avoids loading vendor display drivers for a file conversion.
    // RenderPageToStream on this host crashed inside the AMD driver at teardown.
    let result = (|| -> windows::core::Result<Vec<u8>> {
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            let device = device.ok_or_else(windows::core::Error::from_thread)?;
            let context = context.ok_or_else(windows::core::Error::from_thread)?;
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
                ..Default::default()
            };
            let mut target = None;
            device.CreateTexture2D(&desc, None, Some(&mut target))?;
            let target = target.ok_or_else(windows::core::Error::from_thread)?;
            let dxgi: IDXGIDevice = device.cast()?;
            let surface: IDXGISurface = target.cast()?;
            let renderer = PdfCreateRenderer(&dxgi)?;
            let params = PDF_RENDER_PARAMS {
                DestinationWidth: width,
                DestinationHeight: height,
                BackgroundColor: D2D_COLOR_F {
                    r: 1.,
                    g: 1.,
                    b: 1.,
                    a: 1.,
                },
                IgnoreHighContrast: true,
                ..Default::default()
            };
            renderer.RenderPageToSurface(
                &page.cast::<windows::core::IUnknown>()?,
                &surface,
                POINT::default(),
                Some(&params),
            )?;
            let read_desc = D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..desc
            };
            let mut staging = None;
            device.CreateTexture2D(&read_desc, None, Some(&mut staging))?;
            let staging = staging.ok_or_else(windows::core::Error::from_thread)?;
            context.CopyResource(&staging, &target);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let mut pixels = vec![0; width as usize * height as usize * 4];
            for y in 0..height as usize {
                let row = std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                    width as usize * 4,
                );
                pixels[y * width as usize * 4..(y + 1) * width as usize * 4].copy_from_slice(row);
            }
            context.Unmap(&staging, 0);
            for p in pixels.chunks_exact_mut(4) {
                p.swap(0, 2);
            }
            Ok(pixels)
        }
    })();
    let pixels = result.map_err(|e| msg(format!("Windows PDF software rendering failed: {e}")))?;
    page.Close().map_err(|e| msg(e.to_string()))?;
    use image::ImageEncoder;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&pixels, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| msg(e.to_string()))?;
    Ok(png)
}
#[cfg(not(windows))]
pub fn render(_raw: &[u8], _page: u32) -> Result<Vec<u8>> {
    Err(msg("PDF rendering requires Windows"))
}
#[cfg(windows)]
pub fn ocr(image: &image::DynamicImage) -> Result<String> {
    use windows::{Graphics::Imaging::*, Media::Ocr::OcrEngine, Storage::Streams::*};
    let _apartment = super::super::platform::Apartment::new()?;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|_| msg("No OCR language is available in your Windows language preferences"))?;
    let max = OcrEngine::MaxImageDimension().map_err(|e| msg(e.to_string()))?;
    let scale = (max as f64 / image.width().max(image.height()) as f64).min(1.);
    let image = super::images::resize(
        image,
        (image.width() as f64 * scale).round().max(1.) as u32,
        (image.height() as f64 * scale).round().max(1.) as u32,
    )?;
    let mut pixels = image.to_rgba8().into_raw();
    for p in pixels.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        for value in &mut p[..3] {
            *value = ((u32::from(*value) * a + 255 * (255 - a) + 127) / 255) as u8;
        }
        p.swap(0, 2);
        p[3] = 255;
    }
    let stream = InMemoryRandomAccessStream::new().map_err(|e| msg(e.to_string()))?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(|e| msg(e.to_string()))?;
    writer.WriteBytes(&pixels).map_err(|e| msg(e.to_string()))?;
    let buffer = writer.DetachBuffer().map_err(|e| msg(e.to_string()))?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        image.width() as i32,
        image.height() as i32,
    )
    .map_err(|e| msg(e.to_string()))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|a| a.join())
        .map_err(|e| msg(e.to_string()))?;
    let text = result.Text().map_err(|e| msg(e.to_string()))?.to_string();
    bitmap.Close().map_err(|e| msg(e.to_string()))?;
    Ok(text)
}
#[cfg(not(windows))]
pub fn ocr(_image: &image::DynamicImage) -> Result<String> {
    Err(msg("Text recognition requires Windows"))
}
