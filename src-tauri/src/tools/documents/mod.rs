//! File-only PDF, OCR and QR tools. No clipboard or screen capture access.
pub mod commands;
mod native;
#[cfg(test)]
mod tests;
use super::images;
use crate::error::{msg, Result};
use lopdf::{dictionary, Document, Object, Stream};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Merge,
    Split,
    ImagesPdf,
    Render,
    Ocr,
    QrDecode,
    QrEncode,
}
impl Kind {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Merge | Self::Split | Self::ImagesPdf => "pdf",
            Self::Render | Self::QrEncode => "png",
            _ => "txt",
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub inputs: Vec<String>,
    pub pages: Vec<u32>,
}
impl Options {
    pub fn validate(&self) -> Result<()> {
        if self.inputs.len() > 63 || self.pages.len() > 1000 || self.pages.contains(&0) {
            return Err(msg("Choose at most 64 files and 1000 pages"));
        }
        for path in &self.inputs {
            crate::files::paths::checked(path)?;
        }
        Ok(())
    }
}
fn load(raw: &[u8]) -> Result<Document> {
    let meta =
        Document::load_metadata_mem(raw).map_err(|e| msg(format!("Could not read PDF: {e}")))?;
    if meta.encrypted {
        return Err(msg(
            "Encrypted PDFs are not supported. Save an unencrypted copy first.",
        ));
    }
    let doc = Document::load_mem_with_options(
        raw,
        lopdf::LoadOptions::with_max_decompressed_size(32 * 1024 * 1024),
    )
    .map_err(|e| msg(format!("Could not read PDF: {e}")))?;
    let count = doc.get_pages().len();
    if count == 0 || count > 1000 {
        return Err(msg("Choose a PDF with 1–1000 pages"));
    }
    if doc
        .catalog()
        .is_ok_and(|c| c.has(b"AcroForm") || c.has(b"Collection"))
    {
        return Err(msg(
            "PDF forms and portfolios are not supported; export a flat PDF first",
        ));
    }
    Ok(doc)
}
pub fn page_count(path: &Path, cancel: &AtomicBool) -> Result<u32> {
    Ok(load(&images::source(path, cancel)?)?.get_pages().len() as u32)
}
fn inherited(doc: &Document, page: lopdf::ObjectId) -> Result<lopdf::Dictionary> {
    let mut result = doc
        .get_dictionary(page)
        .map_err(|e| msg(e.to_string()))?
        .clone();
    let mut parent = result
        .get(b"Parent")
        .ok()
        .and_then(|o| o.as_reference().ok());
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = parent {
        if !seen.insert(id) || seen.len() > 64 {
            return Err(msg("Invalid PDF page inheritance"));
        }
        let dictionary = doc.get_dictionary(id).map_err(|e| msg(e.to_string()))?;
        for key in [b"Resources".as_slice(), b"MediaBox", b"CropBox", b"Rotate"] {
            if !result.has(key) {
                if let Ok(value) = dictionary.get(key) {
                    result.set(key, value.clone());
                }
            }
        }
        parent = dictionary
            .get(b"Parent")
            .ok()
            .and_then(|o| o.as_reference().ok());
    }
    result.remove(b"Parent");
    Ok(result)
}
fn finish(mut doc: Document, mut pages: Vec<lopdf::Dictionary>) -> Result<Document> {
    let parent = doc.new_object_id();
    let mut kids = Vec::new();
    for mut page in pages.drain(..) {
        page.set("Parent", parent);
        kids.push(Object::Reference(doc.add_object(page)));
    }
    doc.objects.insert(
        parent,
        Object::Dictionary(dictionary! {"Type"=>"Pages","Count"=>kids.len() as i64,"Kids"=>kids}),
    );
    let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>parent});
    doc.trailer.set("Root", catalog);
    doc.prune_objects();
    Ok(doc)
}
fn assemble(paths: &[PathBuf], pages: &[u32], cancel: &AtomicBool) -> Result<Document> {
    let mut out = Document::with_version("1.7");
    let mut selected = Vec::new();
    for path in paths {
        images::check(cancel)?;
        let mut doc = load(&images::source(path, cancel)?)?;
        for id in doc.get_pages().into_values() {
            let page = inherited(&doc, id)?;
            doc.objects.insert(id, Object::Dictionary(page));
        }
        doc.renumber_objects_with(out.max_id + 1);
        let available = doc.get_pages();
        let ids = if pages.is_empty() {
            available.values().copied().collect::<Vec<_>>()
        } else {
            pages
                .iter()
                .map(|n| {
                    available
                        .get(n)
                        .copied()
                        .ok_or_else(|| msg("Page range is outside this PDF"))
                })
                .collect::<Result<Vec<_>>>()?
        };
        for id in ids {
            selected.push(
                doc.get_dictionary(id)
                    .map_err(|e| msg(e.to_string()))?
                    .clone(),
            );
        }
        if selected.len() > 1000 {
            return Err(msg("The result would exceed 1000 pages"));
        }
        out.max_id = doc.max_id;
        out.objects.extend(doc.objects);
    }
    finish(out, selected)
}
fn images_pdf(engine: &Path, paths: &[PathBuf], cancel: &AtomicBool) -> Result<Document> {
    let mut doc = Document::with_version("1.7");
    let mut pages = Vec::new();
    for path in paths {
        images::check(cancel)?;
        let frame = images::decode(engine, path, cancel)?;
        images::metadata::validate_rgb_profile(&frame.metadata)?;
        let (w, h) = (frame.pixels.width(), frame.pixels.height());
        let jpg = images::encode(
            engine,
            &frame.pixels,
            "jpg",
            90,
            &images::metadata::Metadata::default(),
            cancel,
        )?;
        let colour = if let Some(icc) = frame.metadata.icc {
            let profile = doc.add_object(Stream::new(
                dictionary! {"N"=>3,"Alternate"=>"DeviceRGB"},
                icc,
            ));
            Object::Array(vec![Object::Name(b"ICCBased".to_vec()), profile.into()])
        } else {
            Object::Name(b"DeviceRGB".to_vec())
        };
        let image=doc.add_object(Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Image","Width"=>w,"Height"=>h,"ColorSpace"=>colour,"BitsPerComponent"=>8,"Filter"=>"DCTDecode"},jpg));
        let (pw, ph) = (w as f32 * 0.75, h as f32 * 0.75);
        let content = doc.add_object(Stream::new(
            dictionary! {},
            format!("q {pw} 0 0 {ph} 0 0 cm /Image Do Q\n").into_bytes(),
        ));
        pages.push(dictionary!{"Type"=>"Page","MediaBox"=>vec![0.into(),0.into(),pw.into(),ph.into()],"Resources"=>dictionary!{"XObject"=>dictionary!{"Image"=>image}},"Contents"=>content});
    }
    finish(doc, pages)
}
pub fn qr_decode(image: &image::DynamicImage) -> Result<String> {
    let mut prepared = rqrr::PreparedImage::prepare(image.to_luma8());
    let mut results = Vec::new();
    for grid in prepared.detect_grids() {
        if let Ok((_, text)) = grid.decode() {
            results.push(text);
        }
    }
    if results.is_empty() {
        return Err(msg("No QR code found"));
    }
    Ok(results.join("\n\n"))
}
pub fn qr_encode(text: &str) -> Result<image::GrayImage> {
    if text.trim().is_empty() || text.len() > 8192 {
        return Err(msg("Enter non-empty QR text (up to 8 KB)"));
    }
    let code = qrcode::QrCode::new(text.as_bytes())
        .map_err(|_| msg("This text is too long for a QR code"))?;
    let modules = code.width();
    let scale = 8;
    let width = (modules + 8) * scale;
    Ok(image::GrayImage::from_fn(
        width as u32,
        width as u32,
        |x, y| {
            let (x, y) = (x as usize / scale, y as usize / scale);
            image::Luma([
                if x >= 4
                    && y >= 4
                    && x < modules + 4
                    && y < modules + 4
                    && code[(x - 4, y - 4)] == qrcode::Color::Dark
                {
                    0
                } else {
                    255
                },
            ])
        },
    ))
}
pub fn execute(
    engine: &Path,
    input: &Path,
    output: &Path,
    kind: Kind,
    options: &Options,
    cancel: &AtomicBool,
) -> Result<()> {
    options.validate()?;
    images::check(cancel)?;
    let paths = std::iter::once(input.to_path_buf())
        .chain(options.inputs.iter().map(PathBuf::from))
        .collect::<Vec<_>>();
    match kind {
        Kind::Merge | Kind::Split | Kind::ImagesPdf => {
            let mut doc = if kind == Kind::ImagesPdf {
                images_pdf(engine, &paths, cancel)?
            } else {
                assemble(&paths, &options.pages, cancel)?
            };
            images::check(cancel)?;
            doc.save(output)
                .map_err(|e| msg(format!("Could not write PDF: {e}")))?;
        }
        Kind::Render => {
            if options.pages.len() != 1 {
                return Err(msg("Choose one page for each PNG output"));
            }
            let raw = images::source(input, cancel)?;
            let _ = load(&raw)?;
            let bytes = native::render(&raw, options.pages[0])?;
            images::check(cancel)?;
            std::fs::write(output, bytes)?;
        }
        Kind::Ocr | Kind::QrDecode => {
            let frame = images::decode(engine, input, cancel)?;
            let text = if kind == Kind::Ocr {
                native::ocr(&frame.pixels)?
            } else {
                qr_decode(&frame.pixels)?
            };
            if text.trim().is_empty() {
                return Err(msg("No text found"));
            }
            images::check(cancel)?;
            std::fs::write(output, text.as_bytes())?;
        }
        Kind::QrEncode => {
            let raw = images::source(input, cancel)?;
            if raw.len() > 8192 {
                return Err(msg("QR input must be a UTF-8 text file up to 8 KB"));
            }
            let text = std::str::from_utf8(&raw).map_err(|_| msg("QR input must be UTF-8 text"))?;
            let image = qr_encode(text)?;
            images::check(cancel)?;
            image
                .save_with_format(output, image::ImageFormat::Png)
                .map_err(|e| msg(e.to_string()))?;
        }
    }
    images::check(cancel)
}
