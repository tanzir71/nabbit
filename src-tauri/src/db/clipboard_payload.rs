//! Owned clipboard blobs, with the same exclusions and hash de-duplication as text.
use super::*;
use std::io::Cursor;

impl Database {
    pub fn clipboard_directory(&self) -> PathBuf {
        self.db_path.parent().unwrap().join("clipboard")
    }
    pub(crate) fn clipboard_source_allowed(&self, source: Option<&str>) -> Result<bool> {
        Ok(!source
            .map(|s| self.is_excluded_app(s))
            .transpose()?
            .unwrap_or(false))
    }
    fn add_clipboard_payload(
        &self,
        kind: &str,
        content: String,
        preview: String,
        hash: String,
        source: Option<String>,
        blob: Option<String>,
    ) -> Result<ClipboardEntry> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let now = Utc::now().to_rfc3339();
        conn.execute("INSERT INTO clipboard_entries(id,content_type,content,preview,hash,source_app,pinned,created_at,last_used_at,blob_path) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?7,?8) ON CONFLICT(hash) DO UPDATE SET last_used_at=excluded.last_used_at,source_app=COALESCE(excluded.source_app,clipboard_entries.source_app)",params![Uuid::new_v4().to_string(),kind,content,preview,hash,source,now,blob])?;
        let id: String = conn.query_row(
            "SELECT id FROM clipboard_entries WHERE hash=?1",
            [hash],
            |r| r.get(0),
        )?;
        drop(conn);
        self.get_clipboard_entry(&id)
    }
    pub fn add_clipboard_files(
        &self,
        paths: Vec<String>,
        source: Option<String>,
    ) -> Result<Option<ClipboardEntry>> {
        if !self.clipboard_source_allowed(source.as_deref())? {
            return Ok(None);
        }
        if paths.is_empty()
            || paths.len() > 256
            || paths.iter().any(|p| {
                p.len() > 32768 || p.contains(['\0', '\n', '\r']) || !Path::new(p).is_absolute()
            })
        {
            return Err(msg("Copied files contain an unsupported path"));
        }
        let content = serde_json::to_string(&paths)?;
        if content.len() > 2_000_000 {
            return Err(msg("Copied file list is too large"));
        }
        let preview = if paths.len() == 1 {
            paths[0].clone()
        } else {
            format!(
                "{} files · {}",
                paths.len(),
                Path::new(&paths[0])
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            )
        };
        let hash = sha256_hex(format!("files:{content}").as_bytes());
        self.add_clipboard_payload("file", content, preview, hash, source, None)
            .map(Some)
    }
    pub fn add_clipboard_image(
        &self,
        bytes: &[u8],
        source: Option<String>,
    ) -> Result<Option<ClipboardEntry>> {
        let settings = self.get_settings()?;
        let cap = (settings.image_size_cap_mb.clamp(1, 128) as usize) * 1024 * 1024;
        if !settings.capture_images
            || bytes.len() > cap
            || !self.clipboard_source_allowed(source.as_deref())?
        {
            return Ok(None);
        }
        let mut reader = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| msg(e.to_string()))?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(20000);
        limits.max_image_height = Some(20000);
        limits.max_alloc = Some(256 * 1024 * 1024);
        reader.limits(limits);
        use image::ImageDecoder;
        let mut decoder = reader
            .into_decoder()
            .map_err(|_| msg("The copied image could not be decoded"))?;
        let (width, height) = decoder.dimensions();
        if u64::from(width) * u64::from(height) > 64_000_000 {
            return Err(msg("The copied image exceeds 64 megapixels"));
        }
        let orientation = decoder
            .orientation()
            .map_err(|_| msg("Copied image orientation is unavailable"))?;
        let mut image = image::DynamicImage::from_decoder(decoder)
            .map_err(|_| msg("The copied image could not be decoded"))?;
        image.apply_orientation(orientation);
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|e| msg(e.to_string()))?;
        let png = png.into_inner();
        if png.len() > cap {
            return Ok(None);
        }
        let hash = sha256_hex(&png);
        let directory = self.clipboard_directory();
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{hash}.png"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(&png)?;
                file.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if crate::tools::files::hash_with_cancel(&path, None)? != hash {
                    return Err(msg("Clipboard image storage changed"));
                }
            }
            Err(e) => return Err(e.into()),
        }
        let preview = format!("Image · {} × {}", image.width(), image.height());
        let mut thumbnail = Cursor::new(Vec::new());
        image
            .thumbnail(160, 160)
            .write_to(&mut thumbnail, image::ImageFormat::Png)
            .map_err(|e| msg(e.to_string()))?;
        use base64::Engine;
        let content = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(thumbnail.into_inner())
        );
        self.add_clipboard_payload(
            "image",
            content,
            preview,
            format!("image:{hash}"),
            source,
            Some(path.to_string_lossy().into()),
        )
        .map(Some)
    }
    pub fn clipboard_image_path(&self, id: &str) -> Result<PathBuf> {
        let entry = self.get_clipboard_entry(id)?;
        if entry.content_type != "image" {
            return Err(msg("Choose a clipboard image"));
        }
        let path = PathBuf::from(
            entry
                .blob_path
                .ok_or_else(|| msg("The clipboard image is unavailable"))?,
        );
        if path.parent() != Some(self.clipboard_directory().as_path())
            || path.extension().is_none_or(|e| e != "png")
        {
            return Err(msg("The clipboard image is outside owned storage"));
        }
        let _guard = crate::tools::files::input(&path)?;
        if entry.hash
            != format!(
                "image:{}",
                crate::tools::files::hash_with_cancel(&path, None)?
            )
        {
            return Err(msg("The clipboard image changed"));
        }
        Ok(path)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_images_and_file_lists_are_deduplicated_and_excluded_before_storage() {
        let root = std::env::temp_dir().join(format!("nabbit-context-store-{}", Uuid::new_v4()));
        let db = Database::open(&root).unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(20, 12, image::Rgb([30, 120, 200]))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        assert!(db
            .add_clipboard_image(b"invalid", Some("Bitwarden.exe".into()))
            .unwrap()
            .is_none());
        assert!(!db.clipboard_directory().exists());
        let a = db
            .add_clipboard_image(bytes.get_ref(), None)
            .unwrap()
            .unwrap();
        let b = db
            .add_clipboard_image(bytes.get_ref(), None)
            .unwrap()
            .unwrap();
        assert_eq!(a.id, b.id);
        assert!(db.clipboard_image_path(&a.id).unwrap().is_file());
        let files = vec![root.join("never-opened.png").to_string_lossy().into_owned()];
        let f = db
            .add_clipboard_files(files.clone(), None)
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&f.content).unwrap(),
            files
        );
        assert_eq!(
            db.add_clipboard_files(files, None).unwrap().unwrap().id,
            f.id
        );
        let mut settings = db.get_settings().unwrap();
        settings.capture_images = false;
        db.save_settings(&settings).unwrap();
        assert!(db.add_clipboard_image(b"invalid", None).unwrap().is_none());
        std::fs::write(db.clipboard_image_path(&a.id).unwrap(), b"changed").unwrap();
        assert!(db.clipboard_image_path(&a.id).is_err());
        assert_eq!(db.list_clipboard_entries(None).unwrap().len(), 2);
    }
    #[test]
    fn retention_and_delete_remove_owned_blobs_preserve_pinned_images_and_never_delete_external_references(
    ) {
        let root = std::env::temp_dir().join(format!("nabbit-context-gc-{}", Uuid::new_v4()));
        let db = Database::open(&root.join("app")).unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::new(8, 5)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let entry = db
            .add_clipboard_image(bytes.get_ref(), None)
            .unwrap()
            .unwrap();
        let path = db.clipboard_image_path(&entry.id).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE clipboard_entries SET created_at='2000-01-01T00:00:00Z' WHERE id=?1",
                [&entry.id],
            )
            .unwrap();
        db.toggle_pin_clipboard_entry(&entry.id).unwrap();
        assert_eq!(db.run_retention_gc_for_days(30).unwrap(), 0);
        assert!(path.is_file());
        db.toggle_pin_clipboard_entry(&entry.id).unwrap();
        assert_eq!(db.run_retention_gc_for_days(30).unwrap(), 1);
        assert!(!path.exists());
        let entry = db
            .add_clipboard_image(bytes.get_ref(), None)
            .unwrap()
            .unwrap();
        let path = db.clipboard_image_path(&entry.id).unwrap();
        db.delete_clipboard_entry(&entry.id).unwrap();
        assert!(!path.exists());
        let outside = root.join("unrelated-fixture.txt");
        std::fs::write(&outside, "keep").unwrap();
        let entry = db
            .add_clipboard_text("external pointer fixture", None)
            .unwrap()
            .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE clipboard_entries SET blob_path=?1 WHERE id=?2",
                params![outside.to_string_lossy(), entry.id],
            )
            .unwrap();
        db.clear_clipboard_history().unwrap();
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        assert!(db.list_clipboard_entries(None).unwrap().is_empty());
    }
}
