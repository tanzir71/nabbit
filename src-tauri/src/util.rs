use regex::Regex;
use sha2::{Digest, Sha256};
use url::Url;

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn preview_text(content: &str) -> String {
    let mut preview = content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect::<String>();
    if content.chars().count() > preview.chars().count() {
        preview.push_str("...");
    }
    preview
}

pub fn content_type_for_text(content: &str) -> String {
    if normalize_video_url(content).is_some() || looks_like_url(content) {
        "url".into()
    } else {
        "text".into()
    }
}

pub fn looks_like_url(content: &str) -> bool {
    Url::parse(content.trim()).is_ok()
}

pub fn normalize_video_url(content: &str) -> Option<String> {
    let candidate = extract_first_url(content)?;
    let mut url = Url::parse(&candidate).ok()?;
    let host = url.host_str()?.trim_start_matches("www.").to_lowercase();
    let is_youtube = matches!(
        host.as_str(),
        "youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtube-nocookie.com" | "youtu.be"
    );
    if !is_youtube {
        return None;
    }

    if host == "youtu.be" {
        let id = url.path().trim_matches('/').split('/').next()?;
        if id.is_empty() {
            return None;
        }
        let mut normalized = Url::parse("https://www.youtube.com/watch").ok()?;
        normalized.query_pairs_mut().append_pair("v", id);
        if let Some(list) = url
            .query_pairs()
            .find(|(key, _)| key == "list")
            .map(|(_, value)| value.to_string())
        {
            normalized.query_pairs_mut().append_pair("list", &list);
        }
        return Some(normalized.into());
    }

    url.set_scheme("https").ok()?;
    url.set_host(Some("www.youtube.com")).ok()?;
    let path = url.path().to_string();
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter_map(|(key, value)| match key.as_ref() {
            "v" | "list" | "index" => Some((key.to_string(), value.to_string())),
            _ => None,
        })
        .collect();
    url.set_query(None);

    if path.starts_with("/shorts/") {
        let id = path.trim_start_matches("/shorts/").split('/').next()?;
        url.set_path("/watch");
        url.query_pairs_mut().append_pair("v", id);
    } else if path == "/playlist" || path == "/watch" {
        url.set_path(path.as_str());
    } else if path.starts_with("/embed/") {
        let id = path.trim_start_matches("/embed/").split('/').next()?;
        url.set_path("/watch");
        url.query_pairs_mut().append_pair("v", id);
    } else {
        return None;
    }

    for (key, value) in pairs {
        if !url.query_pairs().any(|(existing, _)| existing == key) {
            url.query_pairs_mut().append_pair(&key, &value);
        }
    }

    let has_video = url
        .query_pairs()
        .any(|(key, value)| key == "v" && !value.is_empty());
    let has_playlist = url
        .query_pairs()
        .any(|(key, value)| key == "list" && !value.is_empty());
    if has_video || has_playlist {
        Some(url.into())
    } else {
        None
    }
}

pub fn extract_first_url(content: &str) -> Option<String> {
    let regex = Regex::new(r#"https?://[^\s<>"']+"#).ok()?;
    regex
        .find(content)
        .map(|value| {
            value
                .as_str()
                .trim_end_matches(['.', ',', ')', ']'])
                .to_string()
        })
        .or_else(|| {
            let trimmed = content.trim();
            if trimmed.starts_with("www.") {
                Some(format!("https://{trimmed}"))
            } else {
                None
            }
        })
}

pub fn default_output_dir() -> String {
    directories::UserDirs::new()
        .and_then(|dirs| dirs.download_dir().map(|path| path.join("Nabbit")))
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("Nabbit")
        })
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_youtube_watch_url() {
        let url =
            normalize_video_url("https://www.youtube.com/watch?v=abc123&utm_source=x&list=PL9")
                .unwrap();
        assert_eq!(url, "https://www.youtube.com/watch?v=abc123&list=PL9");
    }

    #[test]
    fn normalizes_short_url() {
        let url = normalize_video_url("https://youtu.be/abc123?t=44").unwrap();
        assert_eq!(url, "https://www.youtube.com/watch?v=abc123");
    }

    #[test]
    fn normalizes_shorts_url() {
        let url = normalize_video_url("https://youtube.com/shorts/abc123?feature=share").unwrap();
        assert_eq!(url, "https://www.youtube.com/watch?v=abc123");
    }
}
