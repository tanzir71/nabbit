use super::*;
use std::fs;
struct Owned(PathBuf);
impl Owned {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("nabbit-v510-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn pixels() -> DynamicImage {
    DynamicImage::ImageRgba8(image::RgbaImage::from_fn(80, 48, |x, y| {
        image::Rgba([
            (x * 3) as u8,
            (y * 5) as u8,
            90,
            if x < 10 { 100 } else { 255 },
        ])
    }))
}
fn exif() -> Vec<u8> {
    // Orientation + capture date + GPS pointer; marker values must survive conversion.
    let mut b = b"II\x2a\0\x08\0\0\0\x03\0".to_vec();
    b.extend_from_slice(&[0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0]);
    b.extend_from_slice(&[0x32, 1, 2, 0, 20, 0, 0, 0, 50, 0, 0, 0]);
    b.extend_from_slice(&[0x25, 0x88, 4, 0, 1, 0, 0, 0, 70, 0, 0, 0]);
    b.extend_from_slice(&[0, 0, 0, 0]);
    b.extend_from_slice(b"2024:06:01 12:13:14\0");
    b.extend_from_slice(&[1, 0, 1, 0, 2, 0, 2, 0, 0, 0, b'N', 0, 0, 0, 0, 0, 0, 0]);
    b
}
#[test]
fn roundtrip_formats_keep_exif_profile_and_bake_orientation() {
    let owned = Owned::new();
    let cancel = AtomicBool::new(false);
    let meta = metadata::Metadata {
        exif: Some(exif()),
        icc: Some(b"owned-icc-profile-fixture".to_vec()),
    };
    let source = owned.0.join("source.png");
    fs::write(
        &source,
        encode(Path::new(""), &pixels(), "png", 82, &meta, &cancel).unwrap(),
    )
    .unwrap();
    assert_eq!(
        metadata::orientation(
            metadata::read(&fs::read(&source).unwrap())
                .unwrap()
                .exif
                .as_deref()
        ),
        6
    );
    for (format, kind) in [
        ("jpg", Format::Jpg),
        ("png", Format::Png),
        ("webp", Format::Webp),
        ("avif", Format::Avif),
    ] {
        let output = owned.0.join(format!("result.{format}"));
        let report = execute(
            Context {
                ffmpeg: Path::new(""),
                input: &source,
                output: &output,
                options: &Options {
                    format: kind,
                    ..Options::default()
                },
                cancel: &cancel,
            },
            Kind::Convert,
            82,
            None,
        )
        .unwrap();
        assert_eq!((report.width, report.height), (48, 80));
        let raw = fs::read(&output).unwrap();
        let result = metadata::read(&raw).unwrap();
        assert_eq!(result.exif, Some(metadata::upright(&exif(), 48, 80)));
        assert_eq!(result.icc, meta.icc);
        if format != "avif" {
            let decoded = reader(&raw).unwrap().decode().unwrap();
            assert_eq!((decoded.width(), decoded.height()), (48, 80));
        }
    }
}
#[test]
fn lossless_strip_keeps_pixels_and_only_display_orientation() {
    let cancel = AtomicBool::new(false);
    for format in ["jpg", "png", "webp"] {
        let meta = metadata::Metadata {
            exif: Some(exif()),
            icc: Some(b"owned-profile".to_vec()),
        };
        let raw = encode(Path::new(""), &pixels(), format, 85, &meta, &cancel).unwrap();
        let stripped = metadata::strip(raw.clone(), true).unwrap();
        assert_eq!(
            reader(&raw).unwrap().decode().unwrap().to_rgba8(),
            reader(&stripped).unwrap().decode().unwrap().to_rgba8()
        );
        let result = metadata::read(&stripped).unwrap();
        assert_eq!(metadata::orientation(result.exif.as_deref()), 6);
        assert!(result.exif.unwrap().len() < 30);
        assert_eq!(result.icc, meta.icc);
        assert!(!stripped.windows(19).any(|s| s == b"2024:06:01 12:13:14"));
    }
}
#[test]
fn svg_is_bounded_offline_and_alpha_is_composited_for_jpg() {
    let (_,_,image)=svg(br##"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#ff0000" opacity="0.5"/></svg>"##,true).unwrap();
    let rgb = white(&image.unwrap()).to_rgb8();
    assert!(rgb.get_pixel(0, 0)[1] > 120);
    assert!(svg(br#"<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><image href="file:///C:/secret.png"/></svg>"#,true).is_err());
    assert!(svg(
        br#"<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"/>"#,
        false
    )
    .is_err());
}
#[test]
fn cancelled_work_never_writes_a_result_and_options_are_bounded() {
    let owned = Owned::new();
    let input = owned.0.join("a.png");
    pixels().save(&input).unwrap();
    let output = owned.0.join("out.jpg");
    assert!(execute(
        Context {
            ffmpeg: Path::new(""),
            input: &input,
            output: &output,
            options: &Options::default(),
            cancel: &AtomicBool::new(true)
        },
        Kind::Convert,
        85,
        None
    )
    .is_err());
    assert!(!output.exists());
    assert!(Options {
        max_width: Some(0),
        ..Options::default()
    }
    .validate()
    .is_err());
    assert!(dimensions(u32::MAX, 2).is_err());
}
#[test]
fn make_smaller_resizes_from_original_and_meets_actual_bytes() {
    let owned = Owned::new();
    let input = owned.0.join("a.png");
    pixels().save(&input).unwrap();
    let output = owned.0.join("out.png");
    let report = execute(
        Context {
            ffmpeg: Path::new(""),
            input: &input,
            output: &output,
            options: &Options::default(),
            cancel: &AtomicBool::new(false),
        },
        Kind::Smaller,
        85,
        None,
    )
    .unwrap();
    assert!(fs::metadata(output).unwrap().len() < fs::metadata(input).unwrap().len());
    assert!((1..=3).contains(&report.attempts));
}
#[test]
fn unattainable_budget_fails_after_three_original_source_attempts() {
    let owned = Owned::new();
    let input = owned.0.join("large-metadata.png");
    let output = owned.0.join("result.png");
    let cancel = AtomicBool::new(false);
    let mut exif = exif();
    exif.resize(1_100_000, 0);
    let bytes = encode(
        Path::new(""),
        &pixels(),
        "png",
        82,
        &metadata::Metadata {
            exif: Some(exif),
            icc: None,
        },
        &cancel,
    )
    .unwrap();
    fs::write(&input, &bytes).unwrap();
    let error = execute(
        Context {
            ffmpeg: Path::new(""),
            input: &input,
            output: &output,
            options: &Options::default(),
            cancel: &cancel,
        },
        Kind::Fit,
        85,
        Some(1),
    )
    .unwrap_err();
    assert!(error.to_string().contains("after 3 attempts"));
    assert!(!output.exists());
    assert_eq!(fs::read(&input).unwrap(), bytes);
}
#[test]
fn embedded_webp_fallback_honours_quality_and_uses_lossy_pixels() {
    let cancel = AtomicBool::new(false);
    let low = encode(
        Path::new(""),
        &pixels(),
        "webp",
        15,
        &metadata::Metadata::default(),
        &cancel,
    )
    .unwrap();
    let high = encode(
        Path::new(""),
        &pixels(),
        "webp",
        95,
        &metadata::Metadata::default(),
        &cancel,
    )
    .unwrap();
    assert!(low.len() < high.len());
    assert!(high.windows(4).any(|b| b == b"VP8 "));
    assert_eq!(reader(&high).unwrap().decode().unwrap().width(), 80);
}
#[test]
fn non_rgb_profile_is_never_attached_to_rgb_pixels() {
    let mut icc = vec![0; 128];
    icc[16..20].copy_from_slice(b"CMYK");
    icc[36..40].copy_from_slice(b"acsp");
    let error = encode(
        Path::new(""),
        &pixels(),
        "png",
        82,
        &metadata::Metadata {
            exif: None,
            icc: Some(icc),
        },
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert!(error.to_string().contains("colour-managed conversion"));
}
#[test]
fn hostile_container_metadata_never_panics() {
    for n in 0..256 {
        let raw = vec![n as u8; n];
        let _ = metadata::read(&raw);
        let _ = bmff::fallback_safe(&raw);
    }
}
#[test]
#[ignore = "Owned public HEIC sample and pinned ffmpeg are acceptance fixtures, not shipped test data"]
fn native_heic_and_avif_acceptance() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let heic = repo.join(".tools/v510-heic/image1.heic");
    let raw = fs::read(&heic).unwrap();
    assert!(bmff::fallback_safe(&raw)
        .unwrap_err()
        .to_string()
        .contains("tile grids"));
    match native::decode(&raw, true) {
        Ok(bitmap) => {
            assert_eq!((bitmap.width, bitmap.height), (3992, 2992));
            println!("HEIC WIC: decoded full 3992x2992 grid");
        }
        Err(error) => println!("HEIC WIC: skipped; installed codec unavailable: {error}"),
    }
    let owned = Owned::new();
    let avif = owned.0.join("roundtrip.avif");
    let cancel = AtomicBool::new(false);
    fs::write(
        &avif,
        encode(
            Path::new(""),
            &pixels(),
            "avif",
            82,
            &metadata::Metadata {
                exif: Some(exif()),
                icc: None,
            },
            &cancel,
        )
        .unwrap(),
    )
    .unwrap();
    let engine = repo.join("src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe");
    let image = fallback(&engine, &avif, &fs::read(&avif).unwrap(), &cancel).unwrap();
    assert_eq!((image.width(), image.height()), (48, 80));
    println!("AVIF: ffmpeg independently decoded pixels and EXIF orientation");
}
