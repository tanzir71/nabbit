use super::*;
use crate::download::{
    options::DownloadOptions,
    presets::{self, Preset},
};

impl Database {
    /// Reading/remembering a preset is independent of staging or enqueuing media.
    pub fn download_preset(&self, url: &str, fallback_quality: &str) -> Result<Preset> {
        let site = presets::site_key(url)?;
        let raw: Option<String> = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?
            .query_row(
                "SELECT options_json FROM download_presets WHERE site=?1",
                params![site],
                |r| r.get(0),
            )
            .optional()?;
        match raw {
            Some(raw) => presets::from_options(&serde_json::from_str::<DownloadOptions>(&raw)?),
            None => presets::from_options(&DownloadOptions::from_legacy(
                fallback_quality,
                "video",
                None,
            )?),
        }
    }
    pub fn remember_download_preset(&self, url: &str, options: &DownloadOptions) -> Result<Preset> {
        let site = presets::site_key(url)?;
        let preset = presets::from_options(options)?;
        let value = serde_json::to_string(&preset.options)?;
        self.conn.lock().map_err(|_|msg("database lock poisoned"))?.execute("INSERT INTO download_presets(site,options_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(site) DO UPDATE SET options_json=excluded.options_json,updated_at=excluded.updated_at",params![site,value,Utc::now().to_rfc3339()])?;
        Ok(preset)
    }
    pub fn insert_download_and_preset(&self, job: &DownloadJob, remember: bool) -> Result<()> {
        let options = job.options.as_ref().map(|o| o.normalized()).transpose()?;
        let options_json = options.as_ref().map(serde_json::to_string).transpose()?;
        let preset = if remember {
            Some((
                presets::site_key(&job.url)?,
                serde_json::to_string(
                    &presets::from_options(
                        options
                            .as_ref()
                            .ok_or_else(|| msg("Choose options to remember."))?,
                    )?
                    .options,
                )?,
            ))
        } else {
            None
        };
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| msg("database lock poisoned"))?;
        let tx = conn.transaction()?;
        tx.execute("INSERT INTO downloads(id,url,title,thumbnail,status,progress,speed,eta,output_path,error,quality,playlist_mode,playlist_range,created_at,updated_at,options_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",params![job.id,job.url,job.title,job.thumbnail,job.status,job.progress,job.speed,job.eta,job.output_path,job.error,job.quality,job.playlist_mode,job.playlist_range,job.created_at.to_rfc3339(),job.updated_at.to_rfc3339(),options_json])?;
        if let Some((site, value)) = preset {
            tx.execute("INSERT INTO download_presets(site,options_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(site) DO UPDATE SET options_json=excluded.options_json,updated_at=excluded.updated_at",params![site,value,Utc::now().to_rfc3339()])?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "download_presets_tests.rs"]
mod tests;
