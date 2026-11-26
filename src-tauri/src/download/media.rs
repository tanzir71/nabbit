//! Bounded presentation metadata, without media stream URLs or browser credentials.
use crate::{
    capture::web_url,
    db::models::DownloadMetadata,
    error::{msg, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Details {
    pub chapters: Vec<Chapter>,
    pub thumbnails: Vec<String>,
    pub entries: Vec<PlaylistEntry>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub title: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    pub index: u32,
    pub url: Option<String>,
    pub title: String,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub qualities: Vec<super::format_sizes::QualityEstimate>,
}
pub(super) fn image(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    let url = url::Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| value.to_owned())
}
fn milliseconds(value: &Value) -> Option<u64> {
    let seconds = value.as_f64()?;
    (seconds.is_finite() && seconds >= 0.0 && seconds < u64::MAX as f64 / 1000.0)
        .then(|| (seconds * 1000.0).round() as u64)
}
pub fn from_probe(value: &Value, source: &str) -> Details {
    let mut details = Details::default();
    if let Some(chapters) = value.get("chapters").and_then(Value::as_array) {
        details.chapters = chapters
            .iter()
            .take(1000)
            .filter_map(|c| {
                let start_ms = milliseconds(c.get("start_time")?)?;
                let end_ms = milliseconds(c.get("end_time")?)?;
                (end_ms > start_ms).then(|| Chapter {
                    title: c
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Chapter")
                        .to_owned(),
                    start_ms,
                    end_ms,
                })
            })
            .collect();
        details.chapters.sort_by_key(|c| c.start_ms);
    }
    if let Some(images) = value.get("thumbnails").and_then(Value::as_array) {
        for thumbnail in images.iter().rev().filter_map(|t| image(t.get("url"))) {
            if !details.thumbnails.contains(&thumbnail) {
                details.thumbnails.push(thumbnail);
            }
            if details.thumbnails.len() == 8 {
                break;
            }
        }
    }
    if details.thumbnails.is_empty() {
        details.thumbnails.extend(image(value.get("thumbnail")));
    }
    if let Some(entries) = value.get("entries").and_then(Value::as_array) {
        details.truncated = entries.len() > 1000
            || value
                .get("playlist_count")
                .and_then(Value::as_u64)
                .is_some_and(|n| n > entries.len() as u64);
        for (offset, entry) in entries.iter().take(1000).enumerate() {
            let mut target = entry
                .get("webpage_url")
                .or_else(|| entry.get("url"))
                .and_then(Value::as_str)
                .and_then(|u| web_url(u).ok());
            if target.is_none()
                && super::presets::site_key(source).ok().as_deref() == Some("youtube.com")
            {
                if let Some(id) = entry.get("id").and_then(Value::as_str).filter(|id| {
                    !id.is_empty()
                        && id.len() <= 32
                        && id
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
                }) {
                    target = Some(format!("https://www.youtube.com/watch?v={id}"));
                }
            }
            // Unavailable entries keep their original index and are visibly unselectable.
            if entry.is_null()
                || matches!(
                    entry.get("availability").and_then(Value::as_str),
                    Some("private" | "needs_auth" | "subscriber_only")
                )
                || matches!(
                    entry.get("title").and_then(Value::as_str),
                    Some("[Private video]" | "[Deleted video]")
                )
            {
                target = None;
            }
            details.entries.push(PlaylistEntry {
                index: entry
                    .get("playlist_index")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|n| *n > 0)
                    .unwrap_or((offset + 1) as u32),
                url: target,
                title: entry
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Unavailable video")
                    .to_owned(),
                duration: entry
                    .get("duration")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite() && *n > 0.0),
                thumbnail: image(entry.get("thumbnail")).or_else(|| {
                    entry
                        .get("thumbnails")
                        .and_then(Value::as_array)
                        .and_then(|items| items.iter().rev().find_map(|t| image(t.get("url"))))
                }),
                qualities: super::format_sizes::from_probe(entry),
            });
        }
    }
    details
}
pub fn selected(metadata: &DownloadMetadata, indices: &[u32]) -> Result<Vec<PlaylistEntry>> {
    let indices: BTreeSet<_> = indices.iter().copied().collect();
    if !metadata.is_playlist || indices.is_empty() || indices.len() > 1000 {
        return Err(msg("Choose between 1 and 1,000 playlist videos."));
    }
    let entries = &metadata
        .details
        .as_ref()
        .ok_or_else(|| msg("Reload the playlist before downloading."))?
        .entries;
    indices
        .into_iter()
        .map(|i| {
            entries
                .iter()
                .find(|e| e.index == i && e.url.is_some())
                .cloned()
                .ok_or_else(|| {
                    msg(format!(
                        "Playlist video {i} is unavailable. Choose another selection."
                    ))
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_playlists_expose_the_limit_without_fabricating_entries_or_stream_urls() {
        let entries: Vec<_> = (1..=1005)
            .map(|i| serde_json::json!({"id":format!("fixture{i}"),"title":format!("Film {i}")}))
            .collect();
        let value = serde_json::json!({"_type":"playlist","playlist_count":1005,"entries":entries,"url":"https://example.invalid/private-stream","thumbnail":"file:///private"});
        let details = from_probe(&value, "https://www.youtube.com/playlist?list=fixture");
        assert_eq!(details.entries.len(), 1000);
        assert!(details.truncated);
        assert!(details.thumbnails.is_empty());
        assert!(!serde_json::to_string(&details)
            .unwrap()
            .contains("private-stream"));
    }
    #[test]
    fn chapters_thumbnails_and_flat_items_are_bounded_and_preserve_indices() {
        let value = serde_json::json!({"playlist_count":5,"chapters":[{"title":"Two","start_time":3.125,"end_time":9},{"title":"One","start_time":0,"end_time":3.125},{"start_time":9,"end_time":8}],"thumbnails":[{"url":"file:///private"},{"url":"https://example.invalid/poster.png"}],"entries":[{"id":"fixture1","title":"First","duration":12.5},{"id":"private","title":"[Private video]"},null,{"url":"javascript:bad"},{"webpage_url":"https://example.invalid/video","title":"Last"}]});
        let details = from_probe(&value, "https://www.youtube.com/playlist?list=fixture");
        assert_eq!(details.chapters.len(), 2);
        assert_eq!(details.chapters[1].start_ms, 3125);
        assert_eq!(
            details.thumbnails,
            vec!["https://example.invalid/poster.png"]
        );
        assert!(details.entries[0]
            .url
            .as_deref()
            .unwrap()
            .ends_with("v=fixture1"));
        assert!(details.entries[1..4].iter().all(|e| e.url.is_none()));
        assert_eq!(details.entries[4].index, 5);
        assert!(details.entries[4].qualities.is_empty());
        let mut metadata = super::super::ytdlp::metadata_from_value(
            &value,
            "https://www.youtube.com/playlist?list=fixture",
        )
        .unwrap();
        assert_eq!(
            selected(&metadata, &[5, 1, 1])
                .unwrap()
                .iter()
                .map(|e| e.index)
                .collect::<Vec<_>>(),
            vec![1, 5]
        );
        assert!(selected(&metadata, &[2]).is_err());
        assert!(selected(&metadata, &[]).is_err());
        metadata.is_playlist = false;
        assert!(selected(&metadata, &[1]).is_err());
    }
}
