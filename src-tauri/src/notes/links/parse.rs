use crate::error::{msg, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use dom_query::{Document, NodeRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_BOOKMARKS: usize = 25_000;
const ROOT_LABELS: &[&str] = &[
    "bookmarks bar",
    "other bookmarks",
    "mobile bookmarks",
    "bookmarks menu",
    "bookmarks toolbar",
    "bookmarks",
    "unfiled bookmarks",
];
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bookmark {
    pub title: String,
    pub url: String,
    pub labels: Vec<String>,
    pub created_at: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct Parsed {
    pub bookmarks: Vec<Bookmark>,
    pub skipped: usize,
    pub folders: usize,
}
pub fn web_url(input: &str) -> Result<Url> {
    let input = input.trim();
    if input.len() > 16_384 || input.contains('\\') || input.chars().any(char::is_control) {
        return Err(msg(
            "Enter an http or https link without embedded credentials",
        ));
    }
    let parsed = Url::parse(input).map_err(|_| msg("Enter a valid http or https link"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(msg(
            "Enter an http or https link without embedded credentials",
        ));
    }
    Ok(parsed)
}
fn tracking(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.starts_with("utm_") || matches!(lower.as_str(), "fbclid" | "gclid" | "mc_eid")
}
pub fn clean_url(input: &str) -> Result<String> {
    let mut url = web_url(input)?;
    let query = url
        .query_pairs()
        .filter(|(key, _)| !tracking(key))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Ok(url.into())
}
/// Identity only: keep the original address (including useful anchors) on cards.
pub fn normalized_url(input: &str) -> Result<String> {
    let mut url = Url::parse(&clean_url(input)?).map_err(|_| msg("Invalid link"))?;
    url.set_fragment(None);
    if url.path().ends_with('/') && url.path() != "/" {
        let path = url.path().trim_end_matches('/').to_string();
        url.set_path(&path);
    }
    let mut value = url.to_string();
    if url.path() == "/" && url.query().is_none() {
        value.pop();
    }
    Ok(value)
}
pub fn labels(path: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    path.iter()
        .map(String::as_str)
        .filter(|s| !s.is_empty() && !ROOT_LABELS.contains(&s.trim().to_ascii_lowercase().as_str()))
        .map(str::to_owned)
        .filter(|s| seen.insert(s.clone()))
        .collect()
}
fn timestamp(micros: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_micros(micros)
        .filter(|date| (1..=9999).contains(&chrono::Datelike::year(date)))
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
}
pub fn unix_micros(input: i64) -> Option<String> {
    if input > 0 {
        timestamp(input)
    } else {
        None
    }
}
pub fn chromium_date(input: &str) -> Option<String> {
    input
        .parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .and_then(|n| n.checked_sub(11_644_473_600_000_000))
        .and_then(timestamp)
}
pub(super) fn append(
    out: &mut Parsed,
    title: &str,
    url: &str,
    path: &[String],
    created_at: Option<String>,
) -> Result<()> {
    if web_url(url).is_err() {
        out.skipped += 1;
        return Ok(());
    }
    if out.bookmarks.len() >= MAX_BOOKMARKS {
        return Err(msg(
            "A bookmark import is limited to 25,000 links. Split the export and try again.",
        ));
    }
    if title.encode_utf16().count() > 300 {
        return Err(msg("An imported title exceeds 300 characters. Shorten it in the source file and try again."));
    }
    out.bookmarks.push(Bookmark {
        title: title.into(),
        url: url.trim().into(),
        labels: labels(path),
        created_at,
    });
    Ok(())
}
pub fn chromium(text: &str) -> Result<Parsed> {
    let source: Value =
        serde_json::from_str(text).map_err(|_| msg("This Bookmarks file is not valid JSON"))?;
    let roots = source["roots"]
        .as_object()
        .ok_or_else(|| msg("This file has no Chromium bookmark roots"))?;
    let mut out = Parsed::default();
    fn walk(node: &Value, path: &[String], depth: usize, out: &mut Parsed) -> Result<()> {
        if depth > 64 {
            return Err(msg("Bookmark folders are nested too deeply"));
        }
        match node["type"].as_str() {
            Some("url") => append(
                out,
                node["name"].as_str().unwrap_or(""),
                node["url"].as_str().unwrap_or(""),
                path,
                node["date_added"].as_str().and_then(chromium_date),
            )?,
            Some("folder") | None => {
                let mut path = path.to_vec();
                if let Some(name) = node["name"].as_str() {
                    path.push(name.into());
                    out.folders += 1;
                }
                if let Some(children) = node["children"].as_array() {
                    for child in children {
                        walk(child, &path, depth + 1, out)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    for key in ["bookmark_bar", "other", "synced"] {
        if let Some(node) = roots.get(key) {
            walk(node, &[], 0, &mut out)?;
        }
    }
    Ok(out)
}
/// Port of Tack's DOMParser walk (src/import/bookmarks.ts), using HTML5 DOM
/// recovery for Netscape exports; root-name filtering is Nabbit's §8.9 rule.
pub fn html(text: &str) -> Result<Parsed> {
    let document = Document::from(text);
    let mut out = Parsed::default();
    fn walk(node: NodeRef<'_>, path: &[String], depth: usize, out: &mut Parsed) -> Result<()> {
        if depth > 64 {
            return Err(msg("Bookmark folders are nested too deeply"));
        }
        let mut folder = String::new();
        for child in node.children() {
            let name = child
                .node_name()
                .map(|n| n.to_ascii_lowercase())
                .unwrap_or_default();
            if name == "h3" {
                folder = child.text().to_string();
                out.folders += 1;
            }
            if name == "a" {
                let href = child.attr("href").unwrap_or_default();
                if web_url(&href).is_err() {
                    out.skipped += 1;
                    continue;
                }
                let seconds = child
                    .attr("add_date")
                    .and_then(|s| s.trim().parse::<f64>().ok());
                let created_at = if let Some(seconds) = seconds.filter(|n| *n > 0.) {
                    let millis = seconds * 1000.;
                    if !millis.is_finite() || millis > i64::MAX as f64 {
                        return Err(msg("A bookmark has an invalid ADD_DATE"));
                    }
                    Some(
                        timestamp(
                            (millis.trunc() as i64)
                                .checked_mul(1000)
                                .ok_or_else(|| msg("A bookmark has an invalid ADD_DATE"))?,
                        )
                        .ok_or_else(|| msg("A bookmark has an invalid ADD_DATE"))?,
                    )
                } else {
                    None
                };
                append(out, &child.text(), &href, path, created_at)?;
            } else {
                let mut path = path.to_vec();
                if name == "dl" && !folder.is_empty() {
                    path.push(folder.clone());
                }
                walk(child, &path, depth + 1, out)?;
            }
        }
        Ok(())
    }
    walk(document.root(), &[], 0, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_links_are_skipped_before_their_invalid_metadata_is_read() {
        let parsed = super::html(r#"<DL><A HREF="javascript:alert(1)" ADD_DATE="1e100">No</A><A HREF="https://example.invalid/" ADD_DATE="1704067200">Yes</A></DL>"#).unwrap();
        assert_eq!(parsed.skipped, 1);
        assert_eq!(parsed.bookmarks.len(), 1);
    }
    #[test]
    fn normalization_is_for_identity_and_cleaning_preserves_anchor() {
        assert_eq!(
            normalized_url("HTTPS://EXAMPLE.COM/docs/?utm_source=x&key=1&fbclid=y#part").unwrap(),
            "https://example.com/docs?key=1"
        );
        assert_eq!(
            normalized_url("http://EXAMPLE.COM/").unwrap(),
            "http://example.com"
        );
        assert_eq!(
            clean_url("https://example.com/?gclid=x#part").unwrap(),
            "https://example.com/#part"
        );
        for url in [
            "javascript:alert(1)",
            "file:///C:/secret",
            "https://user:pass@example.com/",
        ] {
            assert!(web_url(url).is_err());
        }
    }
    #[test]
    fn chromium_and_netscape_dom_preserve_same_folders_dates_and_safe_links() {
        let json = r#"{"roots":{"bookmark_bar":{"type":"folder","name":"Bookmarks bar","children":[{"type":"folder","name":"Design","children":[{"type":"url","name":"Fonts & type","url":"https://example.com/fonts","date_added":"13348540800000000"},{"type":"url","name":"No","url":"javascript:alert(1)"}]}]}}}"#;
        let html = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Bookmarks bar</H3><DL><p><DT><H3>Design</H3><DL><p><DT><A HREF="https://example.com/fonts" ADD_DATE="1704067200">Fonts &amp; type</A><DT><A HREF="javascript:alert(1)">No</A></DL></DL></DL>"#;
        let first = chromium(json).unwrap();
        let second = super::html(html).unwrap();
        assert_eq!(first.bookmarks, second.bookmarks);
        assert_eq!(first.skipped, 1);
        assert_eq!(second.skipped, 1);
        assert_eq!(first.bookmarks[0].labels, vec!["Design"]);
        assert_eq!(
            first.bookmarks[0].created_at.as_deref(),
            Some("2024-01-01T00:00:00.000Z")
        );
    }
    #[test]
    fn unsafe_schemes_and_oversize_titles_never_become_cards() {
        let mut out = Parsed::default();
        for url in [
            "chrome://settings",
            "place:parent=1",
            "file:///x",
            "javascript:alert(1)",
        ] {
            append(&mut out, "No", url, &[], None).unwrap();
        }
        assert_eq!(out.skipped, 4);
        assert!(out.bookmarks.is_empty());
        assert!(append(
            &mut out,
            &"🙂".repeat(151),
            "https://example.com",
            &[],
            None
        )
        .is_err());
    }
}
