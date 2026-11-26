//! Cached engine health. Only Rust schedules checks; getters never spawn processes.
use super::ytdlp;
use crate::{
    db::{models::EngineStatus, Database},
    error::{msg, Result},
    island::{
        activity::{ActivityEvent, ErrorKind},
        activity_bus,
    },
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

#[path = "engine_process.rs"]
mod process;
pub use process::{run_bounded, ProbeOutput};

pub const SAMPLE: &str = "https://www.youtube.com/watch?v=e6rhUvwB5Y8";
pub const HEALTH_JOB: &str = "engine-health";
pub const DAY: i64 = 86_400;
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Nightly,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extraction {
    pub result: String,
    pub checked_at: Option<String>,
    pub detail: Option<String>,
}

pub struct Service {
    db: Database,
    dir: PathBuf,
    status: Mutex<EngineStatus>,
    operation: Mutex<()>,
    stopped: Mutex<bool>,
    wake: Condvar,
}
impl Service {
    pub fn new(db: Database, dir: PathBuf) -> Arc<Self> {
        let mut status: EngineStatus = db
            .setting_value("engine_health")
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        status.busy = false;
        Arc::new(Self {
            db,
            dir,
            status: Mutex::new(status),
            operation: Mutex::new(()),
            stopped: Mutex::new(false),
            wake: Condvar::new(),
        })
    }
    pub fn snapshot(&self) -> EngineStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn stop(&self) {
        *self.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.wake.notify_all();
    }
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        // Acceptance processes must never touch the network or update real engines.
        if crate::island::acceptance_session() {
            return;
        }
        #[cfg(all(windows, feature = "island-spike"))]
        if crate::island_spike::session_requested() {
            return;
        }
        if std::env::var_os("NABBIT_ACCEPTANCE_COMMAND_DIR").is_some() {
            let service = self.clone();
            std::thread::Builder::new()
                .name("nabbit-engine-local-check".into())
                .spawn(move || {
                    let _operation = service.operation.lock().unwrap_or_else(|e| e.into_inner());
                    let mut status = service.local();
                    status.last_update_check = Some(Utc::now().to_rfc3339());
                    status.extraction = Extraction {
                        result: "skipped".into(),
                        checked_at: status.last_update_check.clone(),
                        detail: Some(
                            "Acceptance session: local version probes only; no network.".into(),
                        ),
                    };
                    service.publish(&app, status);
                })
                .expect("spawn acceptance engine check");
            return;
        }
        let service = self.clone();
        std::thread::Builder::new()
            .name("nabbit-engine-health".into())
            .spawn(move || {
                service.run_local(&app);
                loop {
                    if *service.stopped.lock().unwrap_or_else(|e| e.into_inner()) {
                        break;
                    }
                    let last = service.snapshot().last_update_check;
                    let remaining = seconds_until_check(last.as_deref(), Utc::now().timestamp());
                    if remaining == 0 {
                        let auto = service
                            .db
                            .get_settings()
                            .map(|s| s.engine_auto_update)
                            .unwrap_or(false);
                        service.run(&app, auto, None);
                    } else if service.snapshot().checked_at.is_none() {
                        service.run_local(&app);
                    }
                    let delay = seconds_until_check(
                        service.snapshot().last_update_check.as_deref(),
                        Utc::now().timestamp(),
                    )
                    .max(1);
                    let stopped = service.stopped.lock().unwrap_or_else(|e| e.into_inner());
                    if *stopped {
                        break;
                    }
                    let _ = service
                        .wake
                        .wait_timeout(stopped, Duration::from_secs(delay as u64));
                }
            })
            .expect("spawn engine health");
    }
    fn publish(&self, app: &AppHandle, status: EngineStatus) -> EngineStatus {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
        if let Ok(json) = serde_json::to_string(&status) {
            let _ = self.db.set_setting_value("engine_health", &json);
        }
        if let Some(last) = &status.last_update_check {
            let _ = self.db.set_setting_value("engine_last_update_check", last);
        }
        let _ = app.emit("engine:health", &status);
        activity_bus::publish(app, health_activity(&status));
        status
    }
    fn local(&self) -> EngineStatus {
        let prior = self.snapshot();
        let mut status = EngineStatus {
            channel: prior.channel,
            last_update_check: prior.last_update_check,
            extraction: prior.extraction,
            updated_at: prior.updated_at,
            ..Default::default()
        };
        for name in ["yt-dlp", "deno", "ffmpeg"] {
            let path = ytdlp::resolve_engine(&self.dir, name);
            let version = path.as_deref().and_then(|p| probe_version(p, name).ok());
            if version.is_none() {
                status.missing.push(name.into());
            }
            let path = path.map(|p| p.to_string_lossy().into_owned());
            match name {
                "yt-dlp" => {
                    status.ytdlp_path = path;
                    status.ytdlp_version = version;
                }
                "deno" => {
                    status.deno_path = path;
                    status.deno_version = version;
                }
                _ => {
                    status.ffmpeg_path = path;
                    status.ffmpeg_version = version;
                }
            }
        }
        status.failure = if status.missing.iter().any(|n| n == "deno") {
            Some(ErrorKind::MissingJsRuntime)
        } else if !status.missing.is_empty() || status.extraction.result == "failed" {
            Some(ErrorKind::SiteChanged)
        } else {
            None
        };
        status.checked_at = Some(Utc::now().to_rfc3339());
        status
    }
    fn run_local(&self, app: &AppHandle) {
        let _operation = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        self.publish(app, self.local());
    }
    pub fn run(&self, app: &AppHandle, update: bool, channel: Option<Channel>) -> EngineStatus {
        let _operation = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        let mut busy = self.snapshot();
        busy.busy = true;
        self.publish(app, busy);
        let selected = channel.unwrap_or(self.snapshot().channel);
        let mut update_error = None;
        let mut updated = false;
        if update {
            match update_sidecars(&self.dir, selected) {
                Ok(changed) => {
                    updated = changed;
                }
                Err(error) => {
                    update_error = Some(error.to_string());
                }
            }
        }
        let mut status = self.local();
        if update && update_error.is_none() {
            status.channel = selected;
        }
        if updated {
            status.updated_at = Some(Utc::now().to_rfc3339());
        }
        status.update_error = update_error;
        status.extraction = if status.missing.is_empty() {
            extract(&self.dir)
        } else {
            Extraction {
                result: "skipped".into(),
                checked_at: Some(Utc::now().to_rfc3339()),
                detail: Some("Repair the missing engine components first.".into()),
            }
        };
        if status.missing.is_empty() {
            status.failure =
                (status.extraction.result == "failed").then_some(ErrorKind::SiteChanged);
        }
        status.last_update_check = Some(Utc::now().to_rfc3339());
        self.publish(app, status)
    }
}
pub fn seconds_until_check(last: Option<&str>, now: i64) -> i64 {
    last.and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|v| {
            let elapsed = now - v.timestamp();
            if elapsed < 0 {
                0
            } else {
                (DAY - elapsed).max(0)
            }
        })
        .unwrap_or(0)
}
pub fn health_activity(status: &EngineStatus) -> ActivityEvent {
    if let Some(error) = status.failure {
        ActivityEvent::DownloadFailed {
            job_id: HEALTH_JOB.into(),
            error,
        }
    } else {
        ActivityEvent::DownloadRemoved {
            job_id: HEALTH_JOB.into(),
        }
    }
}
pub fn runtime_args(deno: Option<&Path>) -> Result<Vec<String>> {
    let deno = deno.ok_or(crate::error::NabbitError::MissingJsRuntime)?;
    Ok(vec![
        "--ignore-config".into(),
        "--no-js-runtimes".into(),
        "--js-runtimes".into(),
        format!("deno:{}", deno.display()),
    ])
}
pub fn parse_version(name: &str, stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let version = match name {
        "deno" => line.strip_prefix("deno ")?.split_whitespace().next()?,
        "ffmpeg" => line
            .strip_prefix("ffmpeg version ")?
            .split_whitespace()
            .next()?,
        "yt-dlp" => line,
        _ => return None,
    };
    if name == "yt-dlp" {
        let re = regex::Regex::new(r"^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$").ok()?;
        if !re.is_match(version)
            || version < "2025.11.12"
            || chrono::NaiveDate::parse_from_str(&version[..10], "%Y.%m.%d").is_err()
        {
            return None;
        }
    } else if name == "deno" {
        let valid = regex::Regex::new(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$").ok()?;
        if !valid.is_match(version) {
            return None;
        }
        let parts: Vec<_> = version.split('.').collect();
        if parts.len() != 3
            || parts[0].parse::<u32>().ok()? < 2
            || (parts[0] == "2" && parts[1].parse::<u32>().ok()? < 3)
        {
            return None;
        }
    } else if !regex::Regex::new(r"^(?:n?\d+(?:\.\d+)*|N-\d+|git-[0-9a-f]+)(?:[-+_].*)?$")
        .ok()?
        .is_match(version)
    {
        return None;
    }
    Some(version.to_string())
}
pub fn probe_version(path: &Path, name: &str) -> Result<String> {
    let arg = if name == "ffmpeg" {
        "-version"
    } else {
        "--version"
    };
    let output = run_bounded(path, &[arg.into()], Duration::from_secs(10))?;
    if !output.success {
        return Err(msg(format!("{name} could not start. Repair the engine.")));
    }
    parse_version(name, &output.stdout).ok_or_else(|| {
        msg(format!(
            "{name} returned an unsupported version. Repair the engine."
        ))
    })
}
fn extract(dir: &Path) -> Extraction {
    let result = (|| -> Result<ProbeOutput> {
        let ytdlp = ytdlp::resolve_engine(dir, "yt-dlp").ok_or_else(|| msg("Missing yt-dlp"))?;
        let mut args = runtime_args(ytdlp::resolve_engine(dir, "deno").as_deref())?;
        args.extend(
            [
                "--simulate",
                "--skip-download",
                "--no-playlist",
                "--no-cache-dir",
                "--socket-timeout",
                "3",
                "--retries",
                "0",
                "--print",
                "%(id)s",
                SAMPLE,
            ]
            .map(String::from),
        );
        run_bounded(&ytdlp, &args, Duration::from_secs(3))
    })();
    extraction_result(result)
}
pub fn extraction_result(result: Result<ProbeOutput>) -> Extraction {
    let (result, detail) = match result {
        Ok(o) if o.success && o.stdout.lines().any(|line| line.trim() == "e6rhUvwB5Y8") => {
            ("passed", None)
        }
        Ok(o)
            if [
                "unable to download webpage",
                "name resolution",
                "network is unreachable",
                "connection",
                "timed out",
                "getaddrinfo",
            ]
            .iter()
            .any(|p| o.stderr.to_lowercase().contains(p)) =>
        {
            (
                "skipped",
                Some("Offline or test timed out; checked local engine versions.".into()),
            )
        }
        Ok(_) => (
            "failed",
            Some("The test extraction failed. Update the download engine.".into()),
        ),
        Err(e) if e.to_string().contains("timed out") => (
            "skipped",
            Some("The 3-second test timed out; checked local engine versions.".into()),
        ),
        Err(_) => (
            "failed",
            Some("The test engine could not start. Repair the download engine.".into()),
        ),
    };
    Extraction {
        result: result.into(),
        checked_at: Some(Utc::now().to_rfc3339()),
        detail,
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    #[serde(skip)]
    version: String,
}
fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent("Nabbit-engine")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| msg(format!("Engine connection failed: {e}")))
}
fn release_asset(client: &reqwest::blocking::Client, repo: &str, name: &str) -> Result<Asset> {
    let release: Release = client
        .get(format!(
            "https://api.github.com/repos/{repo}/releases/latest"
        ))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|_| msg("Could not check engine updates. Try again when online."))?;
    release
        .assets
        .into_iter()
        .find(|a| a.name == name)
        .map(|mut a| {
            a.version = release.tag_name;
            a
        })
        .ok_or_else(|| msg("An engine build is not available for this platform."))
}
fn download(client: &reqwest::blocking::Client, asset: &Asset) -> Result<Vec<u8>> {
    if !asset
        .browser_download_url
        .starts_with("https://github.com/")
    {
        return Err(msg("Unexpected engine download source."));
    }
    let response = client
        .get(&asset.browser_download_url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| msg("Engine download failed. Try again when online."))?;
    let mut bytes = Vec::new();
    response.take(180_000_001).read_to_end(&mut bytes)?;
    verify_checksum(
        &bytes,
        asset
            .digest
            .as_deref()
            .and_then(|d| d.strip_prefix("sha256:"))
            .unwrap_or(""),
    )?;
    Ok(bytes)
}
pub fn verify_checksum(bytes: &[u8], expected: &str) -> Result<()> {
    let actual = format!("{:x}", Sha256::digest(bytes));
    if expected.len() != 64 || !actual.eq_ignore_ascii_case(expected) {
        return Err(msg(
            "Engine checksum did not match. The existing engine was kept.",
        ));
    }
    Ok(())
}
fn update_sidecars(dir: &Path, channel: Channel) -> Result<bool> {
    let client = client()?;
    let target = ytdlp::target_triple();
    let name = ytdlp_asset(target).ok_or_else(|| msg("Unsupported engine platform."))?;
    let repo = match channel {
        Channel::Stable => "yt-dlp/yt-dlp",
        Channel::Nightly => "yt-dlp/yt-dlp-nightly-builds",
    };
    let ytdlp = release_asset(&client, repo, name)?;
    let deno = release_asset(&client, "denoland/deno", &format!("deno-{target}.zip"))?;
    let version =
        |name| ytdlp::resolve_engine(dir, name).and_then(|p| probe_version(&p, name).ok());
    if version("yt-dlp").as_deref() == Some(ytdlp.version.as_str())
        && version("deno").as_deref() == Some(deno.version.trim_start_matches('v'))
        && version("ffmpeg").is_some()
    {
        return Ok(false);
    }
    let engine_dir = dir.join("engine");
    fs::create_dir_all(&engine_dir)?;
    if version("ffmpeg").is_none() {
        let bytes = if cfg!(windows) {
            let platform = if cfg!(target_arch = "aarch64") {
                "winarm64"
            } else {
                "win64"
            };
            let asset = release_asset(
                &client,
                "yt-dlp/FFmpeg-Builds",
                &format!("ffmpeg-master-latest-{platform}-gpl.zip"),
            )?;
            let bytes = download(&client, &asset)?;
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
                .map_err(|_| msg("Invalid ffmpeg archive."))?;
            let name = archive
                .file_names()
                .find(|n| n.ends_with("/bin/ffmpeg.exe"))
                .map(str::to_string)
                .ok_or_else(|| msg("ffmpeg missing from archive."))?;
            let mut bytes = Vec::new();
            archive
                .by_name(&name)
                .map_err(|_| msg("Invalid ffmpeg executable."))?
                .take(180_000_001)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 180_000_000 {
                return Err(msg("ffmpeg exceeds the size limit."));
            }
            bytes
        } else {
            let source = which::which(executable("ffmpeg")).map_err(|_| {
                msg("ffmpeg is missing. Run the sidecar setup script to restore it.")
            })?;
            fs::read(source)?
        };
        let staged = prepare(&engine_dir, "ffmpeg", &bytes)?;
        let result = atomic_replace(&staged, &engine_dir.join(executable("ffmpeg")));
        let _ = fs::remove_file(staged);
        result?;
    }
    let yt_bytes = download(&client, &ytdlp)?;
    let deno_zip = download(&client, &deno)?;
    let mut archive =
        zip::ZipArchive::new(Cursor::new(deno_zip)).map_err(|_| msg("Invalid Deno archive."))?;
    let mut file = archive
        .by_name(executable("deno").as_str())
        .map_err(|_| msg("Deno executable missing in archive."))?;
    if file.size() > 180_000_000 {
        return Err(msg("Deno executable exceeds the size limit."));
    }
    let mut deno_bytes = Vec::new();
    file.read_to_end(&mut deno_bytes)?;
    // Probe both candidates before publishing either. A failed probe preserves the old engines.
    let yt = prepare(&engine_dir, "yt-dlp", &yt_bytes)?;
    let deno = match prepare(&engine_dir, "deno", &deno_bytes) {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_file(yt);
            return Err(e);
        }
    };
    let result: Result<()> = (|| {
        atomic_replace(&deno, &engine_dir.join(executable("deno")))?;
        atomic_replace(&yt, &engine_dir.join(executable("yt-dlp")))?;
        Ok(())
    })();
    let _ = fs::remove_file(&yt);
    let _ = fs::remove_file(&deno);
    result?;
    Ok(true)
}
pub fn ytdlp_asset(target: &str) -> Option<&'static str> {
    match target {
        "x86_64-pc-windows-msvc" => Some("yt-dlp.exe"),
        "aarch64-pc-windows-msvc" => Some("yt-dlp_arm64.exe"),
        "x86_64-apple-darwin" | "aarch64-apple-darwin" => Some("yt-dlp_macos"),
        "x86_64-unknown-linux-gnu" => Some("yt-dlp_linux"),
        "aarch64-unknown-linux-gnu" => Some("yt-dlp_linux_aarch64"),
        _ => None,
    }
}
fn executable(name: &str) -> String {
    format!("{name}{}", if cfg!(windows) { ".exe" } else { "" })
}
fn prepare(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    let path = dir.join(executable(&format!(".{name}-{}", uuid::Uuid::new_v4())));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        }
        probe_version(&path, name)?;
        Ok(path.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}
pub fn atomic_replace(from: &Path, to: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<_> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<_> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
