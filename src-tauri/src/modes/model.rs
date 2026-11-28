use crate::db::models::{DisplayMode, DownloadJob};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "percent", rename_all = "camelCase")]
pub enum Badge {
    #[default]
    None,
    Queued,
    Paused,
    Progress(u8),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
    pub mode: DisplayMode,
    pub visible: bool,
    pub badge: Badge,
    pub running: usize,
    pub queued: usize,
    pub paused: usize,
    pub tooltip: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub job_id: String,
    pub title: String,
}
#[derive(Default)]
pub struct Tracker {
    pub mode: DisplayMode,
    active: BTreeMap<String, (String, u8)>,
}
impl Tracker {
    pub fn seed(mode: DisplayMode, jobs: &[DownloadJob]) -> Self {
        let mut tracker = Self {
            mode,
            ..Self::default()
        };
        for job in jobs {
            tracker.update(job);
        }
        tracker
    }
    pub fn update(&mut self, job: &DownloadJob) -> Option<Completion> {
        let previous = self.active.remove(&job.id);
        match job.status.as_str() {
            "queued" | "running" | "paused" => {
                let progress = if job.progress.is_finite() {
                    job.progress.clamp(0.0, 100.0).round() as u8
                } else {
                    0
                };
                self.active
                    .insert(job.id.clone(), (job.status.clone(), progress));
            }
            "completed" if previous.is_some() && self.mode == DisplayMode::TrayOnly => {
                return Some(Completion {
                    job_id: job.id.clone(),
                    title: job
                        .title
                        .chars()
                        .filter(|c| !c.is_control() && !matches!(*c, '\u{fffe}' | '\u{ffff}'))
                        .take(300)
                        .collect(),
                });
            }
            _ => {}
        }
        None
    }
    pub fn presentation(&self) -> Presentation {
        let (mut running, mut queued, mut paused, mut total) = (0, 0, 0, 0_u64);
        for (status, progress) in self.active.values() {
            match status.as_str() {
                "running" => {
                    running += 1;
                    total += u64::from(*progress);
                }
                "queued" => queued += 1,
                "paused" => paused += 1,
                _ => {}
            }
        }
        let percent = if running > 0 {
            (total / running as u64) as u8
        } else {
            0
        };
        let badge = if self.mode != DisplayMode::TrayOnly {
            Badge::None
        } else if running > 0 {
            Badge::Progress(percent)
        } else if paused > 0 {
            Badge::Paused
        } else if queued > 0 {
            Badge::Queued
        } else {
            Badge::None
        };
        let mut parts = Vec::new();
        if running > 0 {
            parts.push(format!("{running} downloading · {percent}%"));
        }
        if queued > 0 {
            parts.push(format!("{queued} queued"));
        }
        if paused > 0 {
            parts.push(format!("{paused} paused"));
        }
        Presentation {
            mode: self.mode,
            visible: self.mode != DisplayMode::IslandOnly,
            badge,
            running,
            queued,
            paused,
            tooltip: if parts.is_empty() {
                "Nabbit".into()
            } else {
                format!("Nabbit — {}", parts.join(" · "))
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(id: &str, status: &str, progress: f64) -> DownloadJob {
        let now = chrono::Utc::now();
        DownloadJob {
            id: id.into(),
            url: "https://example.test/owned".into(),
            title: "Owned <video> & title".into(),
            thumbnail: None,
            status: status.into(),
            progress,
            speed: None,
            eta: None,
            output_path: None,
            error: None,
            failure: None,
            quality: "1080p".into(),
            options: None,
            playlist_mode: "video".into(),
            playlist_range: None,
            created_at: now,
            updated_at: now,
        }
    }
    #[test]
    fn tracks_concurrent_progress_pause_cancel_retry_and_mode_changes_without_polling() {
        let mut tracker = Tracker::seed(DisplayMode::TrayOnly, &[]);
        tracker.update(&job("a", "running", 20.0));
        tracker.update(&job("b", "running", 80.0));
        tracker.update(&job("c", "queued", 0.0));
        assert_eq!(tracker.presentation().badge, Badge::Progress(50));
        assert_eq!(tracker.presentation().queued, 1);
        tracker.update(&job("a", "paused", 20.0));
        tracker.update(&job("b", "cancelled", 80.0));
        assert_eq!(tracker.presentation().badge, Badge::Paused);
        tracker.update(&job("a", "failed", 20.0));
        assert_eq!(tracker.presentation().badge, Badge::Queued);
        tracker.update(&job("c", "running", f64::NAN));
        assert_eq!(tracker.presentation().badge, Badge::Progress(0));
        tracker.mode = DisplayMode::IslandAndTray;
        assert_eq!(tracker.presentation().badge, Badge::None);
        assert!(tracker.presentation().visible);
        tracker.mode = DisplayMode::IslandOnly;
        assert!(!tracker.presentation().visible);
        tracker.mode = DisplayMode::TrayOnly;
        tracker.update(&job("c", "running", 1_000.0));
        assert_eq!(tracker.presentation().badge, Badge::Progress(100));
    }
    #[test]
    fn only_new_active_completions_in_tray_only_notify_and_restart_history_is_silent() {
        let completed = job("old", "completed", 100.0);
        let mut tracker = Tracker::seed(
            DisplayMode::TrayOnly,
            &[completed.clone(), job("a", "paused", 40.0)],
        );
        assert!(tracker.update(&completed).is_none());
        let done = job("a", "completed", 100.0);
        assert_eq!(
            tracker.update(&done).unwrap().title,
            "Owned <video> & title"
        );
        assert!(tracker.update(&done).is_none());
        tracker.update(&job("a", "running", 0.0));
        assert!(tracker.update(&done).is_some());
        for mode in [DisplayMode::IslandOnly, DisplayMode::IslandAndTray] {
            tracker.mode = mode;
            tracker.update(&job("a", "queued", 0.0));
            assert!(tracker.update(&done).is_none());
        }
        assert_eq!(tracker.active.len(), 0);
    }
}
