//! Metadata-only HTTP: one explicit user action, bounded time/body/redirects,
//! no cookie jar, no credentials, no page scripts, favicons or subresources.
use super::parse;
use dom_query::Document;
use std::{io::Read, time::Duration};

fn text(input: &str) -> Option<String> {
    let value = input.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut units = 0;
    let value = value
        .chars()
        .filter(|c| !c.is_control())
        .take_while(|c| {
            units += c.len_utf16();
            units <= 300
        })
        .collect::<String>();
    (!value.is_empty()).then_some(value)
}
pub fn from_html(html: &str) -> Option<String> {
    let doc = Document::from(html);
    doc.select("meta[property='og:title']")
        .attr("content")
        .and_then(|s| text(&s))
        .or_else(|| text(&doc.select("title").text()))
}
pub fn fetch(input: &str, cached: Option<&crate::db::models::DownloadMetadata>) -> String {
    let Ok(url) = parse::web_url(input) else {
        return String::new();
    };
    let fallback = url.host_str().unwrap_or_default().to_string();
    if let Some(metadata) = cached.filter(|m| {
        m.extractor.as_deref() != Some("capture")
            && crate::capture::web_url(input).ok().as_deref() == Some(m.normalized_url.as_str())
    }) {
        if let Some(title) = text(&metadata.title) {
            return title;
        }
    }
    let read = (|| {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(5))
            .cookie_store(false)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() > 5 || parse::web_url(attempt.url().as_str()).is_err() {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .ok()?;
        let response = client
            .get(url)
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
            .send()
            .ok()?;
        if !response.status().is_success()
            || response.content_length().is_some_and(|n| n > 512 * 1024)
        {
            return None;
        }
        let mut bytes = Vec::new();
        response.take(512 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 512 * 1024 {
            return None;
        }
        from_html(&String::from_utf8_lossy(&bytes))
    })();
    read.unwrap_or(fallback)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn og_title_precedes_title_entities_decode_and_utf16_limit_is_respected() {
        assert_eq!(
            from_html(
                "<title>Fallback</title><meta content='Fonts &amp; type' property='og:title'>"
            )
            .as_deref(),
            Some("Fonts & type")
        );
        assert_eq!(
            from_html("<meta property='og:title' content=' '><title>  Page\n title </title>")
                .as_deref(),
            Some("Page title")
        );
        assert_eq!(text(&"🙂".repeat(200)).unwrap().encode_utf16().count(), 300);
    }
}
