//! Classification never opens a copied path or resolves a URL.
use serde::Serialize;
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Text,
    Json,
    Link,
    Video,
    Image,
    Files,
    Path,
}
pub fn text(value: &str) -> Kind {
    let value = value.trim();
    if crate::capture::web_url(value).is_ok() {
        if let Ok(url) = url::Url::parse(value) {
            let host = url.host_str().unwrap_or("").trim_start_matches("www.");
            return if [
                "youtube.com",
                "youtu.be",
                "m.youtube.com",
                "music.youtube.com",
                "vimeo.com",
                "twitch.tv",
                "dailymotion.com",
            ]
            .iter()
            .any(|site| host == *site || host.ends_with(&format!(".{site}")))
            {
                Kind::Video
            } else {
                Kind::Link
            };
        }
    }
    if value.len() <= super::text::LIMIT
        && value.starts_with(['{', '['])
        && serde_json::from_str::<serde::de::IgnoredAny>(value).is_ok()
    {
        return Kind::Json;
    }
    if !value.contains(['\n', '\r', '\0'])
        && ((value.as_bytes().get(1..3) == Some(b":\\")
            && value.as_bytes()[0].is_ascii_alphabetic())
            || value.starts_with("\\\\")
            || (cfg!(not(windows)) && value.starts_with('/')))
    {
        return Kind::Path;
    }
    Kind::Text
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Privacy {
    pub excluded: bool,
    pub history: Option<u32>,
    pub cloud: Option<u32>,
    pub excluded_app: bool,
}
impl Privacy {
    pub fn blocked(self) -> bool {
        self.excluded || self.history == Some(0) || self.cloud == Some(0) || self.excluded_app
    }
}
pub fn silent(notification: Option<i32>) -> bool {
    matches!(notification, Some(2..=4))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classification_is_bounded_and_does_not_read_or_fetch() {
        for (input, kind) in [
            ("https://example.invalid/?utm_source=x", Kind::Link),
            ("https://youtu.be/fixture", Kind::Video),
            ("{\"x\":1}", Kind::Json),
            ("[true,null]", Kind::Json),
            ("{broken}", Kind::Text),
            ("C:\\missing\\file.png", Kind::Path),
            ("\\\\offline\\share\\file", Kind::Path),
            ("javascript:alert(1)", Kind::Text),
            ("https://user:password@example.invalid/", Kind::Text),
            ("ordinary বাংলা text", Kind::Text),
        ] {
            assert_eq!(text(input), kind, "{input}");
        }
    }
    #[test]
    fn each_privacy_format_and_notification_state_suppresses_context() {
        for policy in [
            Privacy {
                excluded: true,
                ..Default::default()
            },
            Privacy {
                history: Some(0),
                ..Default::default()
            },
            Privacy {
                cloud: Some(0),
                ..Default::default()
            },
            Privacy {
                excluded_app: true,
                ..Default::default()
            },
        ] {
            assert!(policy.blocked());
        }
        assert!(!Privacy {
            history: Some(1),
            cloud: Some(1),
            ..Default::default()
        }
        .blocked());
        for state in 0..=7 {
            assert_eq!(silent(Some(state)), (2..=4).contains(&state));
        }
        assert!(!silent(None));
    }
}
