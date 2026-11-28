use super::*;
use std::fs;
struct Owned(PathBuf);
impl Owned {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("nabbit-v510-doc-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn pdf(width: i32) -> Document {
    let mut doc = Document::with_version("1.7");
    let parent = doc.new_object_id();
    let font =
        doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica"});
    let contents = doc.add_object(Stream::new(
        dictionary! {},
        b"BT /F1 20 Tf 10 20 Td (Nabbit) Tj ET".to_vec(),
    ));
    let page = doc.add_object(dictionary! {"Type"=>"Page","Parent"=>parent,"Contents"=>contents});
    doc.objects.insert(parent,Object::Dictionary(dictionary!{"Type"=>"Pages","Count"=>1,"Kids"=>vec![page.into()],"MediaBox"=>vec![0.into(),0.into(),width.into(),100.into()],"Rotate"=>90,"Resources"=>dictionary!{"Font"=>dictionary!{"F1"=>font}}}));
    let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>parent});
    doc.trailer.set("Root", root);
    doc
}
#[test]
fn merge_and_split_preserve_order_inherited_resources_and_page_geometry() {
    let owned = Owned::new();
    let a = owned.0.join("a.pdf");
    let b = owned.0.join("b.pdf");
    pdf(200).save(&a).unwrap();
    pdf(300).save(&b).unwrap();
    let cancel = AtomicBool::new(false);
    let mut merged = assemble(&[b, a], &[], &cancel).unwrap();
    let widths = merged
        .get_pages()
        .into_values()
        .map(|id| {
            merged
                .get_dictionary(id)
                .unwrap()
                .get(b"MediaBox")
                .unwrap()
                .as_array()
                .unwrap()[2]
                .as_i64()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(widths, [300, 200]);
    for id in merged.get_pages().into_values() {
        let p = merged.get_dictionary(id).unwrap();
        assert_eq!(p.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
        assert!(p.has(b"Resources"));
    }
    let path = owned.0.join("merged.pdf");
    merged.save(&path).unwrap();
    let split = assemble(std::slice::from_ref(&path), &[2], &cancel).unwrap();
    assert_eq!(split.get_pages().len(), 1);
    assert!(split.extract_text(&[1]).unwrap().contains("Nabbit"));
    assert!(assemble(&[path], &[3], &cancel).is_err());
}
#[test]
fn encrypted_even_with_empty_password_has_a_clear_error() {
    for password in ["", "owned-fixture"] {
        let mut doc = pdf(200);
        doc.trailer.set(
            "ID",
            vec![
                Object::string_literal(b"nabbit-owned-id".to_vec()),
                Object::string_literal(b"nabbit-owned-id".to_vec()),
            ],
        );
        let state = lopdf::EncryptionState::try_from(lopdf::EncryptionVersion::V1 {
            document: &doc,
            owner_password: "owned-owner",
            user_password: password,
            permissions: lopdf::Permissions::all(),
        })
        .unwrap();
        doc.encrypt(&state).unwrap();
        let mut raw = Vec::new();
        doc.save_to(&mut raw).unwrap();
        assert!(load(&raw)
            .unwrap_err()
            .to_string()
            .contains("Encrypted PDFs"));
    }
}
#[test]
fn qr_roundtrip_preserves_unicode_newlines_and_never_opens_links() {
    let text = "https://example.com/owned\nNabbit বাংলা";
    let image = qr_encode(text).unwrap();
    assert_eq!(
        qr_decode(&image::DynamicImage::ImageLuma8(image)).unwrap(),
        text
    );
    assert!(qr_encode("").is_err());
    assert!(qr_encode(&"a".repeat(9000)).is_err());
    assert!(qr_decode(&image::DynamicImage::new_rgb8(32, 32))
        .unwrap_err()
        .to_string()
        .contains("No QR"));
}
#[test]
fn images_pdf_keeps_order_aspect_and_source_bytes() {
    let owned = Owned::new();
    let cancel = AtomicBool::new(false);
    let mut paths = Vec::new();
    let mut hashes = Vec::new();
    for (i, (w, h)) in [(80, 40), (30, 70)].iter().enumerate() {
        let path = owned.0.join(format!("{i}.png"));
        image::RgbImage::new(*w, *h).save(&path).unwrap();
        hashes.push(super::super::files::hash(&path).unwrap());
        paths.push(path);
    }
    let doc = images_pdf(Path::new(""), &paths, &cancel).unwrap();
    assert_eq!(doc.get_pages().len(), 2);
    for (path, hash) in paths.iter().zip(hashes) {
        assert_eq!(super::super::files::hash(path).unwrap(), hash);
    }
    let dims = doc
        .get_pages()
        .into_values()
        .map(|id| {
            doc.get_dictionary(id)
                .unwrap()
                .get(b"MediaBox")
                .unwrap()
                .as_array()
                .unwrap()
                .clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(dims[0][2].as_float().unwrap(), 60.);
    assert_eq!(dims[1][3].as_float().unwrap(), 52.5);
}
#[cfg(windows)]
#[test]
fn windows_pdf_render_uses_owned_files() {
    let mut raw = Vec::new();
    pdf(200).save_to(&mut raw).unwrap();
    let png = native::render(&raw, 1).unwrap();
    let image = image::load_from_memory(&png).unwrap();
    assert_eq!((image.width(), image.height()), (200, 400));
}
#[cfg(windows)]
#[test]
fn windows_ocr_uses_owned_files() {
    let owned = Owned::new();
    let svg = owned.0.join("ocr.svg");
    fs::write(&svg,r#"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="240"><rect width="1200" height="240" fill="white"/><text x="20" y="150" font-family="Geist" font-size="100" fill="black">NABBIT 510</text></svg>"#).unwrap();
    let frame = images::decode(Path::new(""), &svg, &AtomicBool::new(false)).unwrap();
    match native::ocr(&frame.pixels) {
        Ok(text) => {
            assert!(text.to_uppercase().contains("NABBIT"), "{text}");
            println!("Windows OCR fixture: {text}");
        }
        Err(error) if error.to_string().contains("No OCR language") => {
            println!("Windows OCR: skipped; no installed user language")
        }
        Err(error) => panic!("{error}"),
    }
    let blank = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        400,
        200,
        image::Rgb([255, 255, 255]),
    ));
    if let Ok(text) = native::ocr(&blank) {
        assert!(text.trim().is_empty());
    }
}
