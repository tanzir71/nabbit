//! Bounded still-image processing using existing ffmpeg, Rust codecs and WIC.
mod bmff;
pub mod commands;
pub mod metadata;
pub mod model;
mod native;
#[cfg(test)]
mod tests;
use crate::error::{msg, Result};
use image::{DynamicImage, ImageDecoder, ImageEncoder};
pub use model::*;
use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
pub struct Frame {
    pub pixels: DynamicImage,
    pub metadata: metadata::Metadata,
    pub decoder: String,
}
pub fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(msg("Cancelled"))
    } else {
        Ok(())
    }
}
pub fn source(path: &Path, cancel: &AtomicBool) -> Result<Vec<u8>> {
    check(cancel)?;
    let file = super::files::input(path)?;
    if file.metadata()?.len() > MAX_FILE {
        return Err(msg("Image input exceeds the 128 MB limit"));
    }
    let mut raw = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut raw)?;
    if raw.len() as u64 > MAX_FILE {
        return Err(msg("Image input exceeds the 128 MB limit"));
    }
    check(cancel)?;
    Ok(raw)
}
fn reader(raw: &[u8]) -> Result<image::ImageReader<Cursor<&[u8]>>> {
    let mut reader = image::ImageReader::new(Cursor::new(raw))
        .with_guessed_format()
        .map_err(|e| msg(e.to_string()))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(20000);
    limits.max_image_height = Some(20000);
    limits.max_alloc = Some(MAX_PIXELS * 4);
    reader.limits(limits);
    Ok(reader)
}
fn svg(raw: &[u8], pixels: bool) -> Result<(u32, u32, Option<DynamicImage>)> {
    let text = std::str::from_utf8(raw).map_err(|_| msg("SVG must be UTF-8"))?;
    let href = regex::Regex::new(r#"(?i)(?:href\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)'"\s]+))"#)
        .expect("constant SVG expression");
    if href.captures_iter(text).any(|c| {
        c.get(1)
            .or_else(|| c.get(2))
            .is_some_and(|m| !m.as_str().starts_with('#') && !m.as_str().starts_with("data:"))
    }) {
        return Err(msg(
            "Embed linked images and fonts into the SVG before converting it",
        ));
    }
    let mut options = resvg::usvg::Options::default();
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    options
        .fontdb_mut()
        .load_font_data(include_bytes!("../../../../src/assets/fonts/Geist-Variable.ttf").to_vec());
    options.font_family = "Geist".into();
    let tree = resvg::usvg::Tree::from_data(raw, &options)
        .map_err(|e| msg(format!("Could not read SVG: {e}")))?;
    let size = tree.size().to_int_size();
    let (width, height) = (size.width(), size.height());
    dimensions(width, height)?;
    if !pixels {
        return Ok((width, height, None));
    }
    let mut map = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| msg("Could not allocate SVG pixels"))?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::identity(),
        &mut map.as_mut(),
    );
    // tiny-skia pixels are premultiplied; convert once to the image crate's straight RGBA.
    let mut rgba = map.take();
    for p in rgba.chunks_exact_mut(4) {
        let a = u32::from(p[3]);
        for value in &mut p[..3] {
            *value = (u32::from(*value) * 255 + a / 2)
                .checked_div(a)
                .unwrap_or(0)
                .min(255) as u8;
        }
    }
    let pixels = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| msg("Invalid SVG pixel buffer"))?;
    Ok((width, height, Some(DynamicImage::ImageRgba8(pixels))))
}
fn format(path: &Path) -> String {
    path.extension()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}
fn animated(raw: &[u8]) -> bool {
    use img_parts::DynImage;
    match DynImage::from_bytes(raw.to_vec().into()).ok().flatten() {
        Some(DynImage::Png(p)) => p.chunks().iter().any(|c| c.kind() == *b"acTL"),
        Some(DynImage::WebP(w)) => w.chunks().iter().any(|c| c.id() == *b"ANIM"),
        _ => false,
    }
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn fallback(ffmpeg: &Path, path: &Path, raw: &[u8], cancel: &AtomicBool) -> Result<DynamicImage> {
    bmff::fallback_safe(raw)?;
    let root = std::env::temp_dir().join(format!("nabbit-image-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root)?;
    let owned = Temporary(root);
    let out = owned.0.join("decoded.png");
    let args = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov",
        "-i",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain([
        path.to_string_lossy().into(),
        "-map".into(),
        "0:V:0".into(),
        "-frames:v".into(),
        "1".into(),
        "-c:v".into(),
        "png".into(),
        "-progress".into(),
        "pipe:1".into(),
        out.to_string_lossy().into(),
    ])
    .collect::<Vec<_>>();
    super::process::run(
        ffmpeg,
        &args,
        1.,
        cancel,
        &|_| {},
        std::time::Duration::from_secs(30),
    )?;
    let bytes = source(&out, cancel)?;
    let mut image = reader(&bytes)?.decode().map_err(|e| msg(e.to_string()))?;
    // ffmpeg applies HEIF container rotation; fall back to EXIF only when none is present.
    if !bmff::container_transform(raw)? {
        let meta = metadata::read(raw)?;
        image.apply_orientation(
            image::metadata::Orientation::from_exif(metadata::orientation(meta.exif.as_deref()))
                .unwrap_or(image::metadata::Orientation::NoTransforms),
        );
    }
    dimensions(image.width(), image.height())?;
    Ok(image)
}
pub fn inspect(ffmpeg: &Path, path: &Path, cancel: &AtomicBool) -> Result<Info> {
    let raw = source(path, cancel)?;
    let fmt = format(path);
    let meta = metadata::read(&raw)?;
    let orientation = metadata::orientation(meta.exif.as_deref());
    let (width, height, decoder) = if fmt == "svg" {
        let (w, h, _) = svg(&raw, false)?;
        (w, h, "resvg".into())
    } else if matches!(fmt.as_str(), "heic" | "heif" | "avif") {
        match native::decode(&raw, false) {
            Ok(b) => (b.width, b.height, "WIC".into()),
            Err(_) => {
                let image=fallback(ffmpeg,path,&raw,cancel).map_err(|e|msg(format!("Could not decode {fmt}. Windows HEIF/HEVC extensions may be required for HEIC (HEVC may cost $0.99). {e}")))?;
                (image.width(), image.height(), "ffmpeg".into())
            }
        }
    } else {
        let mut decoder = reader(&raw)?
            .into_decoder()
            .map_err(|e| msg(e.to_string()))?;
        let (mut w, mut h) = decoder.dimensions();
        if decoder
            .orientation()
            .map_err(|e| msg(e.to_string()))?
            .to_exif()
            >= 5
        {
            std::mem::swap(&mut w, &mut h);
        }
        (w, h, "image".into())
    };
    dimensions(width, height)?;
    check(cancel)?;
    Ok(Info {
        width,
        height,
        bytes: raw.len() as u64,
        format: fmt,
        orientation,
        has_exif: meta.exif.is_some(),
        has_profile: meta.icc.is_some(),
        animated: animated(&raw),
        decoder,
    })
}
pub fn decode(ffmpeg: &Path, path: &Path, cancel: &AtomicBool) -> Result<Frame> {
    let raw = source(path, cancel)?;
    if animated(&raw) {
        return Err(msg(
            "Choose a still image; conversion would discard animation",
        ));
    }
    let metadata = metadata::read(&raw)?;
    let fmt = format(path);
    let (pixels, decoder) = if fmt == "svg" {
        (svg(&raw, true)?.2.expect("requested SVG pixels"), "resvg")
    } else if matches!(fmt.as_str(), "heic" | "heif" | "avif") {
        match native::decode(&raw, true) {
            Ok(b) => (
                DynamicImage::ImageRgba8(
                    image::RgbaImage::from_raw(
                        b.width,
                        b.height,
                        b.pixels.expect("requested WIC pixels"),
                    )
                    .ok_or_else(|| msg("Invalid WIC pixel buffer"))?,
                ),
                "WIC",
            ),
            Err(_) => (fallback(ffmpeg, path, &raw, cancel)?, "ffmpeg"),
        }
    } else {
        let mut d = reader(&raw)?
            .into_decoder()
            .map_err(|e| msg(e.to_string()))?;
        let orientation = d.orientation().map_err(|e| msg(e.to_string()))?;
        let mut image = DynamicImage::from_decoder(d).map_err(|e| msg(e.to_string()))?;
        image.apply_orientation(orientation);
        (image, "image")
    };
    dimensions(pixels.width(), pixels.height())?;
    check(cancel)?;
    Ok(Frame {
        pixels,
        metadata,
        decoder: decoder.into(),
    })
}
pub fn resize(image: &DynamicImage, width: u32, height: u32) -> Result<DynamicImage> {
    dimensions(width, height)?;
    if width == image.width() && height == image.height() {
        return Ok(image.clone());
    }
    let src = DynamicImage::ImageRgba8(image.to_rgba8());
    let mut dest =
        fast_image_resize::images::Image::new(width, height, fast_image_resize::PixelType::U8x4);
    fast_image_resize::Resizer::new()
        .resize(&src, &mut dest, &fast_image_resize::ResizeOptions::new())
        .map_err(|e| msg(e.to_string()))?;
    Ok(DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width, height, dest.into_vec())
            .ok_or_else(|| msg("Invalid resized buffer"))?,
    ))
}
fn white(image: &DynamicImage) -> DynamicImage {
    let rgba = image.to_rgba8();
    let mut rgb = image::RgbImage::new(image.width(), image.height());
    for (from, to) in rgba.pixels().zip(rgb.pixels_mut()) {
        let a = u32::from(from[3]);
        for i in 0..3 {
            to[i] = ((u32::from(from[i]) * a + 255 * (255 - a) + 127) / 255) as u8;
        }
    }
    DynamicImage::ImageRgb8(rgb)
}
pub fn encode(
    ffmpeg: &Path,
    image: &DynamicImage,
    fmt: &str,
    quality: u8,
    meta: &metadata::Metadata,
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    check(cancel)?;
    metadata::validate_rgb_profile(meta)?;
    let ffmpeg_webp = if fmt == "webp" && ffmpeg.is_file() {
        let listing = crate::download::engine::run_bounded(
            ffmpeg,
            &["-hide_banner".into(), "-encoders".into()],
            std::time::Duration::from_secs(5),
        );
        check(cancel)?;
        listing.is_ok_and(|r| {
            r.success
                && r.stdout
                    .lines()
                    .any(|line| line.split_whitespace().nth(1) == Some("libwebp"))
        })
    } else {
        false
    };
    let mut out = Vec::new();
    match fmt {
        "jpg" => {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
                .encode_image(&white(image))
                .map_err(|e| msg(e.to_string()))?;
        }
        "png" => {
            image::codecs::png::PngEncoder::new(&mut out)
                .write_image(
                    image.to_rgba8().as_raw(),
                    image.width(),
                    image.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| msg(e.to_string()))?;
            let mut opts = oxipng::Options::from_preset(2);
            opts.timeout = Some(std::time::Duration::from_secs(5));
            opts.max_decompressed_size = Some(MAX_PIXELS as usize * 4 + 20000);
            out = oxipng::optimize_from_memory(&out, &opts).map_err(|e| msg(e.to_string()))?;
        }
        "avif" => {
            let mut encoder =
                image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut out, 8, quality)
                    .with_num_threads(Some(2));
            if let Some(exif) = &meta.exif {
                encoder
                    .set_exif_metadata(exif.clone())
                    .map_err(|e| msg(e.to_string()))?;
            }
            encoder
                .write_image(
                    image.to_rgba8().as_raw(),
                    image.width(),
                    image.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| msg(e.to_string()))?;
            if let Some(icc) = &meta.icc {
                out = bmff::with_icc(out, icc)?;
            }
        }
        "webp" if !ffmpeg_webp => {
            let rgba = image.to_rgba8();
            let encoded = webp::Encoder::from_rgba(rgba.as_raw(), image.width(), image.height())
                .encode_simple(false, f32::from(quality))
                .map_err(|e| msg(format!("Could not encode WebP: {e:?}")))?;
            out.extend_from_slice(&encoded);
        }
        "webp" => {
            let root = std::env::temp_dir().join(format!("nabbit-webp-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root)?;
            let owned = Temporary(root);
            let input = owned.0.join("pixels.png");
            let output = owned.0.join("encoded.webp");
            image
                .save_with_format(&input, image::ImageFormat::Png)
                .map_err(|e| msg(e.to_string()))?;
            let args = vec![
                "-hide_banner".into(),
                "-nostdin".into(),
                "-v".into(),
                "error".into(),
                "-protocol_whitelist".into(),
                "file,pipe".into(),
                "-format_whitelist".into(),
                "png_pipe".into(),
                "-i".into(),
                input.to_string_lossy().into(),
                "-frames:v".into(),
                "1".into(),
                "-c:v".into(),
                "libwebp".into(),
                "-quality".into(),
                quality.to_string(),
                "-progress".into(),
                "pipe:1".into(),
                output.to_string_lossy().into(),
            ];
            super::process::run(
                ffmpeg,
                &args,
                1.,
                cancel,
                &|_| {},
                std::time::Duration::from_secs(60),
            )?;
            out = source(&output, cancel)?;
        }
        _ => return Err(msg("Choose JPG, PNG, WebP or AVIF")),
    }
    check(cancel)?;
    if fmt != "avif" {
        out = metadata::attach(out, meta)?;
    }
    Ok(out)
}

pub struct Context<'a> {
    pub ffmpeg: &'a Path,
    pub input: &'a Path,
    pub output: &'a Path,
    pub options: &'a Options,
    pub cancel: &'a AtomicBool,
}
pub fn execute(
    context: Context<'_>,
    kind: Kind,
    quality: u32,
    max_mb: Option<u32>,
) -> Result<Report> {
    let Context {
        ffmpeg,
        input,
        output,
        options,
        cancel,
    } = context;
    options.validate()?;
    let raw = source(input, cancel)?;
    if kind == Kind::Strip {
        let bytes = metadata::strip(raw, options.keep_profile)?;
        check(cancel)?;
        std::fs::write(output, bytes)?;
        return Ok(Report {
            encoder: "img-parts".into(),
            attempts: 1,
            lossless: true,
            ..Report::default()
        });
    }
    let target = if kind == Kind::Fit {
        Some(
            u64::from(
                max_mb
                    .filter(|v| *v > 0)
                    .ok_or_else(|| msg("Choose a size limit"))?,
            ) * 1_000_000,
        )
    } else if kind == Kind::Smaller {
        Some(raw.len().saturating_sub(1) as u64)
    } else {
        None
    };
    if kind == Kind::Fit
        && target.is_some_and(|n| raw.len() as u64 <= n)
        && !options.strip_metadata
        && options.max_width.is_none()
        && options.format == Format::Original
        && matches!(
            format(input).as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "avif"
        )
    {
        std::fs::write(output, &raw)?;
        return Ok(Report {
            encoder: "copy".into(),
            lossless: true,
            attempts: 1,
            ..Report::default()
        });
    }
    let frame = decode(ffmpeg, input, cancel)?;
    let fmt = options.format.extension(input);
    let (width, height) = fitted(
        frame.pixels.width(),
        frame.pixels.height(),
        options.max_width,
    );
    let original = resize(&frame.pixels, width, height)?;
    let initial_quality = options.quality.unwrap_or(quality).clamp(1, 100);
    let mut last_size = 0;
    for attempt in 0..if target.is_some() { 3 } else { 1 } {
        check(cancel)?;
        let scale = [1.0, 0.8, 0.55][attempt];
        let w = ((width as f64 * scale).round() as u32).max(1);
        let h = ((height as f64 * scale).round() as u32).max(1);
        let pixels = resize(&original, w, h)?;
        let mut meta = frame.metadata.clone();
        meta.exif = if options.strip_metadata {
            None
        } else {
            meta.exif.map(|e| metadata::upright(&e, w, h))
        };
        if !options.keep_profile {
            meta.icc = None;
        }
        let q = initial_quality
            .saturating_sub((attempt as u32) * 18)
            .max(20);
        let bytes = encode(ffmpeg, &pixels, fmt, q as u8, &meta, cancel)?;
        last_size = bytes.len();
        if target.is_none_or(|n| bytes.len() as u64 <= n) {
            check(cancel)?;
            std::fs::write(output, &bytes)?;
            return Ok(Report {
                encoder: format!("{fmt} via {}", frame.decoder),
                width: w,
                height: h,
                quality: q,
                attempts: attempt as u32 + 1,
                lossless: fmt == "png",
                warning: None,
            });
        }
    }
    Err(msg(format!("Could not meet the size limit after 3 attempts (last output {last_size} bytes). Try a lower maximum width or JPG/WebP.")))
}
