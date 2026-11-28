use crate::{
    db::Database,
    error::{msg, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
pub const ORDER: [&str; 4] = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub id: String,
    pub driver: Option<i64>,
}
pub fn adapters() -> Result<Vec<Adapter>> {
    #[cfg(windows)]
    unsafe {
        use windows::{core::Interface, Win32::Graphics::Dxgi::*};
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| msg(e.to_string()))?;
        let mut result = Vec::new();
        for index in 0..32 {
            let Ok(adapter) = factory.EnumAdapters1(index) else {
                break;
            };
            let desc = adapter.GetDesc1().map_err(|e| msg(e.to_string()))?;
            if desc.Flags & 2 != 0 {
                continue;
            }
            result.push(Adapter {
                id: format!(
                    "{:x}:{:x}:{:x}:{}:{}",
                    desc.VendorId,
                    desc.DeviceId,
                    desc.SubSysId,
                    desc.AdapterLuid.HighPart,
                    desc.AdapterLuid.LowPart
                ),
                driver: adapter.CheckInterfaceSupport(&IDXGIDevice::IID).ok(),
            });
        }
        Ok(result)
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Probe {
    pub encoder: String,
    pub working: bool,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub adapters: Vec<Adapter>,
    pub selected: Option<String>,
    pub probes: Vec<Probe>,
    pub webp: bool,
    pub checked: bool,
    pub cached: bool,
    pub cacheable: bool,
}
pub fn cache_key(engine: &str, adapters: &[Adapter]) -> Option<String> {
    use sha2::{Digest, Sha256};
    if adapters.is_empty() || adapters.iter().any(|a| a.driver.is_none()) {
        return None;
    }
    let key = serde_json::to_vec(&(engine, adapters)).ok()?;
    Some(format!("{:x}", Sha256::digest(key)))
}
pub fn choose_with(mut run: impl FnMut(&str) -> Result<()>) -> (Option<String>, Vec<Probe>) {
    let mut probes = Vec::new();
    for encoder in ORDER {
        let result = run(encoder);
        let working = result.is_ok();
        probes.push(Probe {
            encoder: encoder.into(),
            working,
            error: result
                .err()
                .map(|e| e.to_string().chars().take(1024).collect()),
        });
        if working {
            return (Some(encoder.into()), probes);
        }
    }
    (None, probes)
}
pub fn capabilities(
    ffmpeg: &Path,
    db: &Database,
    probe_gpu: bool,
    cancel: &AtomicBool,
) -> Result<Capabilities> {
    let adapters = adapters().unwrap_or_default();
    // The executable is verified before this call. Its pin is part of the cache
    // identity, alongside every GPU LUID/device and actual UMD driver version.
    let engine = super::super::files::hash_with_cancel(ffmpeg, Some(cancel))?;
    let key = cache_key(&engine, &adapters);
    if let Some(key) = &key {
        let value: Option<String> = {
            use rusqlite::OptionalExtension;
            let conn = db.conn.lock().map_err(|_| msg("Database unavailable"))?;
            conn.query_row(
                "SELECT value FROM media_capabilities WHERE key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()?
        };
        if let Some(value) = value {
            let mut result: Capabilities = serde_json::from_str(&value)?;
            if result.checked || !probe_gpu {
                result.cached = true;
                return Ok(result);
            }
        }
    }
    let listing = crate::download::engine::run_bounded(
        ffmpeg,
        &["-hide_banner".into(), "-encoders".into()],
        Duration::from_secs(5),
    )?;
    let webp = listing.success
        && listing
            .stdout
            .lines()
            .any(|line| line.split_whitespace().nth(1) == Some("libwebp_anim"));
    let mut result = Capabilities {
        adapters,
        webp,
        cacheable: key.is_some(),
        ..Capabilities::default()
    };
    if probe_gpu {
        let (selected, probes) = choose_with(|encoder| {
            if cancel.load(Ordering::Acquire) {
                return Err(msg("Cancelled"));
            }
            let mut args = [
                "-hide_banner",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=1920x1080:rate=30:duration=1",
                "-an",
                "-c:v",
                encoder,
                "-pix_fmt",
                "yuv420p",
                "-frames:v",
                "30",
                "-f",
                "null",
                "-",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
            if encoder == "h264_mf" {
                args.splice(
                    args.len() - 3..args.len() - 3,
                    ["-hw_encoding".into(), "1".into()],
                );
            }
            super::super::process::run(ffmpeg, &args, 1., cancel, &|_| {}, Duration::from_secs(10))
        });
        if cancel.load(Ordering::Acquire) {
            return Err(msg("Cancelled"));
        }
        result.selected = selected;
        result.probes = probes;
        result.checked = true;
    }
    if let Some(key) = key {
        db.conn.lock().map_err(|_|msg("Database unavailable"))?.execute("INSERT INTO media_capabilities(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",rusqlite::params![key,serde_json::to_string(&result)?])?;
    }
    Ok(result)
}
