//! Every data-file open goes through Reader's explicit capability list. Browser
//! discovery only lists known profile roots and reads Local State/Bookmarks;
//! Firefox queries only bookmark rows from a private, read-only SQLite copy.
use super::parse::{self, Parsed, MAX_FILE_BYTES};
use crate::error::{msg, Result};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Default)]
pub struct Roots {
    pub local: Option<PathBuf>,
    pub roaming: Option<PathBuf>,
}
impl Roots {
    pub fn system() -> Self {
        Self {
            local: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
            roaming: std::env::var_os("APPDATA").map(PathBuf::from),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub browser: String,
    pub files: Vec<String>,
    pub links: usize,
    pub folders: usize,
    pub skipped: usize,
    pub error: Option<String>,
    #[serde(skip)]
    pub parsed: Parsed,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub sources: Vec<Source>,
    pub read_files: Vec<String>,
}
#[derive(Default)]
pub struct Reader {
    allowed: HashMap<PathBuf, PathBuf>,
    opened: Vec<PathBuf>,
}
impl Reader {
    fn permit(&mut self, path: &Path, root: &Path) -> Result<()> {
        let root = fs::canonicalize(root)?;
        let resolved = fs::canonicalize(path)?;
        if !resolved.starts_with(&root) || !resolved.is_file() {
            return Err(msg("Bookmark file resolves outside its selected profile"));
        }
        self.allowed.insert(path.to_path_buf(), resolved);
        Ok(())
    }
    pub fn read(&mut self, path: &Path) -> Result<Vec<u8>> {
        let file = self.open(path)?;
        if file.metadata()?.len() > MAX_FILE_BYTES {
            return Err(msg("A bookmark file exceeds the 16 MB import limit"));
        }
        let mut raw = Vec::new();
        file.take(MAX_FILE_BYTES + 1).read_to_end(&mut raw)?;
        if raw.len() as u64 > MAX_FILE_BYTES {
            return Err(msg("A bookmark file exceeds the 16 MB import limit"));
        }
        Ok(raw)
    }
    fn open(&mut self, path: &Path) -> Result<File> {
        let expected = self
            .allowed
            .get(path)
            .ok_or_else(|| msg("This file is not on the bookmark read allow-list"))?;
        if &fs::canonicalize(path)? != expected {
            return Err(msg("Bookmark file changed location; rescan sources"));
        }
        let file = File::open(path)?;
        self.opened.push(path.to_path_buf());
        Ok(file)
    }
    fn copy_sqlite(&mut self, source: &Path, destination: &Path) -> Result<()> {
        // Firefox's database also contains history and can be much larger than
        // a bookmark export. Stream bytes to the private copy without loading
        // them into RAM; only bookmark rows are queried afterwards.
        const LIMIT: u64 = 2 * 1024 * 1024 * 1024;
        let input = self.open(source)?;
        if input.metadata()?.len() > LIMIT {
            return Err(msg(
                "This Firefox database is too large to copy. Export bookmarks as HTML instead.",
            ));
        }
        let mut output = File::create(destination)?;
        if std::io::copy(&mut input.take(LIMIT + 1), &mut output)? > LIMIT {
            return Err(msg(
                "This Firefox database is too large to copy. Export bookmarks as HTML instead.",
            ));
        }
        Ok(())
    }
    fn text(&mut self, path: &Path) -> Result<String> {
        String::from_utf8(self.read(path)?)
            .map_err(|_| msg("Bookmark files must contain UTF-8 text"))
    }
    fn files(&self) -> Vec<String> {
        let mut paths = self
            .opened
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        paths
    }
}
fn component(name: &str) -> bool {
    let mut parts = Path::new(name).components();
    matches!(parts.next(), Some(Component::Normal(_)))
        && parts.next().is_none()
        && !name.contains(['\\', '/'])
}
fn id(path: &Path) -> String {
    format!(
        "source-{:x}",
        Sha256::digest(path.to_string_lossy().as_bytes())
    )
}
fn source(
    path: &Path,
    name: String,
    browser: &str,
    files: Vec<String>,
    parsed: Result<Parsed>,
) -> Source {
    let (parsed, error) = match parsed {
        Ok(p) => (p, None),
        Err(error) => (
            Parsed::default(),
            Some(
                format!("Could not read these bookmarks: {error}. Export an HTML file from this browser instead."),
            ),
        ),
    };
    Source {
        id: id(path),
        name,
        browser: browser.into(),
        files,
        links: parsed.bookmarks.len(),
        folders: parsed.folders,
        skipped: parsed.skipped,
        error,
        parsed,
    }
}
pub fn discover(roots: &Roots) -> Result<Discovery> {
    let mut reader = Reader::default();
    let mut sources = Vec::new();
    if let Some(local) = &roots.local {
        for (browser, parts) in [
            ("Chrome", vec!["Google", "Chrome", "User Data"]),
            ("Edge", vec!["Microsoft", "Edge", "User Data"]),
            ("Brave", vec!["BraveSoftware", "Brave-Browser", "User Data"]),
            ("Vivaldi", vec!["Vivaldi", "User Data"]),
        ] {
            let root = parts.iter().fold(local.clone(), |p, v| p.join(v));
            if !root.is_dir() {
                continue;
            }
            let state = root.join("Local State");
            let mut names = HashMap::new();
            let mut metadata_files = Vec::new();
            if state.is_file() && reader.permit(&state, &root).is_ok() {
                metadata_files.push(state.to_string_lossy().into_owned());
                if let Ok(raw) = reader.text(&state) {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                        if let Some(cache) = value["profile"]["info_cache"].as_object() {
                            for (name, profile) in cache {
                                if component(name) {
                                    names.insert(
                                        name.clone(),
                                        profile["name"].as_str().unwrap_or(name).to_string(),
                                    );
                                }
                            }
                        }
                    }
                }
            }
            let mut profiles = fs::read_dir(&root)?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| {
                    component(name)
                        && (name == "Default"
                            || name.starts_with("Profile ")
                            || names.contains_key(name))
                })
                .collect::<Vec<_>>();
            profiles.sort();
            profiles.truncate(64);
            for name in profiles {
                let path = root.join(&name).join("Bookmarks");
                if !path.is_file() {
                    continue;
                }
                let mut files = metadata_files.clone();
                files.push(path.to_string_lossy().into_owned());
                let parsed = reader
                    .permit(&path, &root)
                    .and_then(|()| reader.text(&path))
                    .and_then(|text| parse::chromium(&text));
                sources.push(source(
                    &path,
                    format!("{browser} · {}", names.get(&name).unwrap_or(&name)),
                    browser,
                    files,
                    parsed,
                ));
            }
        }
    }
    if let Some(roaming) = &roots.roaming {
        let root = roaming.join("Mozilla").join("Firefox").join("Profiles");
        if root.is_dir() {
            let mut profiles = fs::read_dir(&root)?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.path())
                .collect::<Vec<_>>();
            profiles.sort();
            profiles.truncate(64);
            for profile in profiles {
                let path = profile.join("places.sqlite");
                if !path.is_file() {
                    continue;
                }
                let wal = profile.join("places.sqlite-wal");
                let mut files = vec![path.to_string_lossy().into_owned()];
                let parsed = (|| {
                    reader.permit(&path, &root)?;
                    if wal.is_file() {
                        reader.permit(&wal, &root)?;
                        files.push(wal.to_string_lossy().into_owned());
                    }
                    firefox(&mut reader, &path, wal.is_file().then_some(wal.as_path()))
                })();
                let name = format!(
                    "Firefox · {}",
                    profile.file_name().unwrap_or_default().to_string_lossy()
                );
                sources.push(source(&path, name, "Firefox", files, parsed));
            }
        }
    }
    Ok(Discovery {
        sources,
        read_files: reader.files(),
    })
}
pub fn selected_html(path: &Path) -> Result<Discovery> {
    if !path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("html") || s.eq_ignore_ascii_case("htm"))
    {
        return Err(msg("Choose a bookmarks .html or .htm export"));
    }
    let mut reader = Reader::default();
    reader.permit(
        path,
        path.parent().ok_or_else(|| msg("Invalid bookmark file"))?,
    )?;
    let parsed = parse::html(&reader.text(path)?)?;
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    Ok(Discovery {
        sources: vec![source(
            path,
            name,
            "HTML",
            vec![path.to_string_lossy().into_owned()],
            Ok(parsed),
        )],
        read_files: reader.files(),
    })
}
struct CopyDir(PathBuf);
impl Drop for CopyDir {
    fn drop(&mut self) {
        // This directory was exclusively created by us, contains only the two
        // copied bookmark files and SQLite's own sidecars, and never aliases a profile.
        if self
            .0
            .file_name()
            .is_some_and(|s| s.to_string_lossy().starts_with("nabbit-bookmarks-"))
            && self.0.parent() == Some(std::env::temp_dir().as_path())
        {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
fn firefox(reader: &mut Reader, path: &Path, wal: Option<&Path>) -> Result<Parsed> {
    let temp = std::env::temp_dir().join(format!("nabbit-bookmarks-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&temp)?;
    let copy = CopyDir(temp);
    let signature = |p: &Path| -> Result<_> {
        let m = fs::metadata(p)?;
        Ok((m.len(), m.modified()?))
    };
    let mut stable = false;
    for _ in 0..3 {
        let before = (signature(path)?, wal.map(signature).transpose()?);
        reader.copy_sqlite(path, &copy.0.join("places.sqlite"))?;
        if let Some(wal) = wal {
            reader.copy_sqlite(wal, &copy.0.join("places.sqlite-wal"))?;
        }
        if before == (signature(path)?, wal.map(signature).transpose()?) {
            stable = true;
            break;
        }
    }
    if !stable {
        return Err(msg(
            "Firefox bookmarks are changing. Try again or export an HTML file.",
        ));
    }
    let db = Connection::open_with_flags(
        copy.0.join("places.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    db.execute_batch("PRAGMA query_only=ON;")?;
    let folders = db
        .prepare("SELECT id,parent,COALESCE(title,'') FROM moz_bookmarks WHERE type=2")?
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                (r.get::<_, i64>(1)?, r.get::<_, String>(2)?),
            ))
        })?
        .collect::<std::result::Result<HashMap<_, _>, _>>()?;
    let mut out = Parsed {
        folders: folders.len(),
        ..Default::default()
    };
    let mut statement=db.prepare("SELECT b.parent,COALESCE(b.title,p.title,''),p.url,b.dateAdded FROM moz_bookmarks b JOIN moz_places p ON b.fk=p.id WHERE b.type=1 ORDER BY b.id")?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows {
        let (mut parent, title, url, date) = row?;
        let mut seen = HashSet::new();
        let mut path = Vec::new();
        while let Some((next, name)) = folders.get(&parent) {
            if path.len() > 64 || !seen.insert(parent) {
                return Err(msg("Bookmark folder hierarchy is invalid"));
            }
            path.push(name.clone());
            parent = *next;
        }
        path.reverse();
        parse::append(&mut out, &title, &url, &path, parse::unix_micros(date))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allow_list_rejects_non_bookmark_paths_before_opening_them() {
        let temp =
            std::env::temp_dir().join(format!("nabbit-source-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&temp).unwrap();
        let allowed = temp.join("Bookmarks");
        let forbidden = temp.join("History");
        fs::write(&allowed, b"{}").unwrap();
        fs::write(&forbidden, b"private").unwrap();
        let mut reader = Reader::default();
        reader.permit(&allowed, &temp).unwrap();
        assert!(reader.read(&forbidden).is_err());
        assert!(reader.opened.is_empty());
        assert_eq!(reader.read(&allowed).unwrap(), b"{}");
        assert_eq!(reader.opened, vec![allowed]);
        fs::remove_file(forbidden).unwrap();
        fs::remove_file(&reader.opened[0]).unwrap();
        fs::remove_dir(temp).unwrap();
    }
}
