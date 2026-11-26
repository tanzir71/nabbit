//! One stderr classifier and recovery contract for persisted rows and island events.
use crate::{
    db::models::DownloadJob,
    error::{msg, Result},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum ErrorKind {
    SignInRequired,
    SiteChanged,
    MissingJsRuntime,
    FormatUnavailable,
    Drm,
    Disk,
    Offline,
    Live,
    Unknown,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub kind: ErrorKind,
    pub title: String,
    pub description: String,
    pub actions: Vec<Action>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    SignIn,
    Retry,
    UpdateEngine,
    CopyDetails,
    InstallDeno,
    Dismiss,
    BestAvailable,
    Choose,
    ChooseFolder,
    Cancel,
    WaitForVideo,
}

pub fn classify(stderr: &str) -> ErrorKind {
    let lower = stderr.to_lowercase().replace('’', "'");
    // A terminal ERROR wins over unrelated warnings (e.g. optional PO-token formats).
    let errors = lower
        .lines()
        .filter(|s| s.contains("error:") || s.contains("exception:"))
        .collect::<Vec<_>>()
        .join("\n");
    let text = if errors.is_empty() {
        lower.as_str()
    } else {
        &errors
    };
    let has = |patterns: &[&str]| patterns.iter().any(|p| text.contains(p));
    let drm_word = text
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|word| word == "drm");
    if (drm_word && !text.contains("drm-free") && !text.contains("not drm"))
        || has(&[
            "drm protected",
            "drm-protected",
            "encrypted streams",
            "media is encrypted",
            "encrypted with",
        ])
    {
        ErrorKind::Drm
    } else if has(&[
        "sign in",
        "signed in",
        "sign-in",
        "age-restrict",
        "age restrict",
        "age-gat",
        "members-only",
        "members only",
        "join this channel",
        "login required",
        "authentication required",
    ]) {
        ErrorKind::SignInRequired
    } else if has(&[
        "missingjsruntime",
        "no supported javascript runtime",
        "javascript runtime is required",
        "deno sidecar missing",
    ]) || (lower.contains("no supported javascript runtime")
        && has(&["requested format", "no video formats"]))
    {
        ErrorKind::MissingJsRuntime
    } else if has(&[
        "no space left",
        "disk full",
        "not enough space",
        "errno 28",
        "winerror 112",
        "access denied",
        "permission denied",
        "winerror 5",
        "path too long",
        "filename too long",
        "winerror 206",
        "errno 36",
    ]) {
        ErrorKind::Disk
    } else if has(&[
        "http error 403",
        "http error 401",
        "http 403",
        "403 forbidden",
        "nsig",
        "signature extraction",
        "signature solving",
        "po token",
        "po-token",
        "potoken",
    ]) {
        ErrorKind::SiteChanged
    } else if has(&[
        "requested format is not available",
        "no video formats found",
        "no suitable formats",
    ]) {
        ErrorKind::FormatUnavailable
    } else if has(&[
        "name or service not known",
        "getaddrinfo failed",
        "temporary failure in name resolution",
        "failed to resolve",
        "nodename nor servname",
        "network is unreachable",
        "network is down",
        "connection refused",
        "connection reset",
        "unable to connect",
        "connection timed out",
        "connecttimeout",
        "read timed out",
        "winerror 10051",
        "winerror 10060",
        "winerror 11001",
    ]) {
        ErrorKind::Offline
    } else if has(&[
        "is_live",
        "is_upcoming",
        "post_live",
        "this is still live",
        "live event will begin",
        "premiere will begin",
        "not currently live",
        "has not started",
        "scheduled for",
        "upcoming premiere",
        "--break-on-reject",
    ]) {
        ErrorKind::Live
    } else {
        ErrorKind::Unknown
    }
}
impl ErrorKind {
    pub fn compact_title(self) -> &'static str {
        match self {
            Self::SignInRequired => "YouTube wants you signed in",
            Self::SiteChanged => "YouTube changed something",
            Self::MissingJsRuntime => "The engine needs its helper",
            Self::FormatUnavailable => "That quality isn’t offered",
            Self::Drm => "This media is protected",
            Self::Disk => "Check the download folder",
            Self::Offline => "You’re offline",
            Self::Live => "This is still live",
            Self::Unknown => "Download failed",
        }
    }
}
pub fn for_job(job: &DownloadJob) -> Option<Failure> {
    if job.status != "failed" {
        return None;
    }
    let kind = classify(job.error.as_deref().unwrap_or_default());
    let (description, actions) = match kind {
        ErrorKind::SignInRequired => ("Use your browser’s sign-in for this one download. Nabbit reads that browser’s cookies only for this request.", vec![Action::SignIn, Action::Retry]),
        ErrorKind::SiteChanged => ("A newer download engine usually fixes this within a day. Nabbit checks daily; you can update now.", vec![Action::UpdateEngine, Action::CopyDetails]),
        ErrorKind::MissingJsRuntime => ("yt-dlp now needs Deno to see every YouTube format. One-time download, about 40 MB.", vec![Action::InstallDeno, Action::Dismiss]),
        ErrorKind::FormatUnavailable => ("Download the best available quality instead, or pick another preset.", vec![Action::BestAvailable, Action::Choose]),
        ErrorKind::Drm => ("Nabbit doesn’t download DRM-protected content, and won’t try to work around it.", vec![Action::Dismiss]),
        ErrorKind::Disk => ("Free some space or save somewhere else. Check that the folder is writable and the full filename is not too long.", vec![Action::ChooseFolder, Action::Retry]),
        ErrorKind::Offline => ("It’s queued. Nabbit resumes automatically when you’re back online.", vec![Action::Cancel]),
        ErrorKind::Live => ("Nabbit can save the replay once the stream ends.", vec![Action::WaitForVideo, Action::Cancel]),
        ErrorKind::Unknown => ("The downloader could not finish this item. Retry, or copy the details to investigate.", vec![Action::Retry, Action::CopyDetails]),
    };
    let title = match kind {
        ErrorKind::FormatUnavailable => format!(
            "{} isn’t offered for this video",
            job.options
                .as_ref()
                .map(|o| o.legacy_quality())
                .unwrap_or_else(|| job.quality.clone())
                .replace("audio_", "")
                .replace("best", "Best quality")
        ),
        ErrorKind::Disk => {
            let dir = job
                .options
                .as_ref()
                .and_then(|o| o.output_dir.as_deref())
                .unwrap_or_default();
            let drive = if dir.as_bytes().get(1) == Some(&b':') {
                &dir[..2]
            } else {
                "the download drive"
            };
            format!("Not enough space on {drive}")
        }
        _ => kind.compact_title().into(),
    };
    Some(Failure {
        kind,
        title,
        description: description.into(),
        actions,
    })
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Recovery {
    Retry,
    SignIn {
        browser: super::options::Browser,
    },
    BestAvailable,
    Options {
        options: super::options::DownloadOptions,
        browser: Option<super::options::Browser>,
    },
    Folder {
        output_dir: String,
    },
    WaitForVideo,
}
/// A pure validation seam: no process, profile, preset or clipboard access.
pub fn apply_recovery(
    job: &DownloadJob,
    recovery: &Recovery,
) -> Result<super::options::DownloadOptions> {
    if job.status != "failed" && job.status != "cancelled" {
        return Err(msg("This download is already active or has finished."));
    }
    let kind = classify(job.error.as_deref().unwrap_or_default());
    if kind == ErrorKind::Drm && job.status == "failed" {
        return Err(msg("This media is protected. Nabbit cannot download it."));
    }
    let mut options = job.options.clone().map(Ok).unwrap_or_else(|| {
        super::options::DownloadOptions::from_legacy(
            &job.quality,
            &job.playlist_mode,
            job.playlist_range.as_deref(),
        )
    })?;
    match recovery {
        Recovery::BestAvailable if kind == ErrorKind::FormatUnavailable => options.height = None,
        Recovery::Options { options: next, .. } => options = next.clone(),
        Recovery::Folder { output_dir } if kind == ErrorKind::Disk => {
            if output_dir.trim().is_empty() {
                return Err(msg("Choose an output folder."));
            }
            options.output_dir = Some(output_dir.trim().into());
        }
        Recovery::WaitForVideo if kind == ErrorKind::Live => options.wait_for_video = true,
        Recovery::Retry | Recovery::SignIn { .. } => (),
        _ => return Err(msg("This action does not match the download problem.")),
    }
    options.normalized()
}

#[cfg(test)]
#[path = "errors_tests.rs"]
mod tests;
