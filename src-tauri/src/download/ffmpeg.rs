//! BtbN's static GPL executable is a process boundary, never a linked library.
use crate::error::{msg, Result};
use std::{
    io::Read,
    path::{Path, PathBuf},
};
pub fn pin(target: &str) -> Result<serde_json::Value> {
    let pins: serde_json::Value =
        serde_json::from_str(include_str!("../../../scripts/engine-pins.json"))?;
    let pin = pins["targets"][target]["ffmpeg"].clone();
    if pin["executableSha256"].as_str().is_none() {
        return Err(msg("This platform has no pinned conversion engine"));
    }
    Ok(pin)
}
pub fn verified(dir: &Path) -> Result<PathBuf> {
    let path = super::ytdlp::resolve_engine(dir, "ffmpeg")
        .ok_or_else(|| msg("ffmpeg is missing. Run Repair engine in Settings."))?;
    #[cfg(windows)]
    {
        let pin = pin(super::ytdlp::target_triple())?;
        if !matches_pin(&path, &pin).unwrap_or(false) {
            for bundled in shipped_paths() {
                if matches_pin(&bundled, &pin).unwrap_or(false) {
                    return Ok(bundled);
                }
            }
            return Err(msg(
                "The conversion engine needs updating. Run Repair engine in Settings.",
            ));
        }
    }
    Ok(path)
}
fn matches_pin(path: &Path, pin: &serde_json::Value) -> Result<bool> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    if file.metadata()?.len() > 180_000_000 {
        return Ok(false);
    }
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(Some(format!("{:x}", hash.finalize()).as_str()) == pin["executableSha256"].as_str())
}
pub fn current(dir: &Path) -> bool {
    if !cfg!(windows) {
        return super::ytdlp::resolve_engine(dir, "ffmpeg").is_some();
    }
    super::ytdlp::resolve_engine(dir, "ffmpeg")
        .and_then(|path| {
            pin(super::ytdlp::target_triple())
                .ok()
                .map(|p| matches_pin(&path, &p).unwrap_or(false))
        })
        .unwrap_or(false)
}
fn shipped_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            paths.push(parent.join("ffmpeg.exe"));
        }
    }
    paths.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("ffmpeg-{}.exe", super::ytdlp::target_triple())),
    );
    paths
}
pub fn install(client: &reqwest::blocking::Client, engine_dir: &Path) -> Result<()> {
    let pin = pin(super::ytdlp::target_triple())?;
    // Prefer the exact executable already shipped with this app. Repair and
    // conversion keep working when the upstream daily asset has been retired.
    for bundled in shipped_paths() {
        if std::fs::metadata(&bundled).is_ok_and(|metadata| metadata.len() > 180_000_000) {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&bundled) {
            if super::engine::verify_checksum(
                &bytes,
                pin["executableSha256"].as_str().unwrap_or_default(),
            )
            .is_ok()
            {
                let staged = super::engine::prepare(engine_dir, "ffmpeg", &bytes)?;
                let result = super::engine::atomic_replace(&staged, &engine_dir.join("ffmpeg.exe"));
                let _ = std::fs::remove_file(staged);
                return result;
            }
        }
    }
    let url = pin["url"]
        .as_str()
        .ok_or_else(|| msg("Invalid ffmpeg pin"))?;
    if !url.starts_with("https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/")
        || !url.ends_with("-gpl.zip")
    {
        return Err(msg("Unexpected ffmpeg source"));
    }
    let mut bytes = Vec::new();
    client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| msg("Could not download ffmpeg. Try Repair engine when online."))?
        .take(275_000_001)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 275_000_000 {
        return Err(msg("ffmpeg archive exceeds its size limit"));
    }
    super::engine::verify_checksum(&bytes, pin["sha256"].as_str().unwrap_or_default())?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| msg("Invalid ffmpeg archive"))?;
    let name = zip
        .file_names()
        .find(|n| n.ends_with("/bin/ffmpeg.exe"))
        .map(str::to_string)
        .ok_or_else(|| msg("ffmpeg missing from archive"))?;
    let mut binary = Vec::new();
    zip.by_name(&name)
        .map_err(|_| msg("Invalid ffmpeg executable"))?
        .take(180_000_001)
        .read_to_end(&mut binary)?;
    if binary.len() > 180_000_000 {
        return Err(msg("ffmpeg executable exceeds its size limit"));
    }
    super::engine::verify_checksum(
        &binary,
        pin["executableSha256"].as_str().unwrap_or_default(),
    )?;
    let staged = super::engine::prepare(engine_dir, "ffmpeg", &binary)?;
    let result = super::engine::atomic_replace(&staged, &engine_dir.join("ffmpeg.exe"));
    let _ = std::fs::remove_file(staged);
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_windows_conversion_builds_are_pinned_gpl_separate_executables() {
        for target in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {
            let p = pin(target).unwrap();
            assert!(p["url"].as_str().unwrap().ends_with("-gpl.zip"));
            assert!(!p["url"].as_str().unwrap().contains("yt-dlp"));
            assert_eq!(p["executableSha256"].as_str().unwrap().len(), 64);
            assert_eq!(p["sha256"].as_str().unwrap().len(), 64);
        }
    }
}
