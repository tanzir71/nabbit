//! Bounded, local text transforms. The caller retains the original history item.
use crate::error::{msg, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;

pub const LIMIT: usize = 2_000_000;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextTool {
    pub id: &'static str,
    pub name: &'static str,
    pub group: &'static str,
}
pub fn catalog() -> Vec<TextTool> {
    [
        ("upper", "UPPERCASE", "case"),
        ("lower", "lowercase", "case"),
        ("title", "Title Case", "case"),
        ("sentence", "Sentence case", "case"),
        ("kebab", "kebab-case", "case"),
        ("snake", "snake_case", "case"),
        ("trim", "Trim lines", "lines"),
        ("sort", "Sort lines", "lines"),
        ("dedupe", "Remove duplicate lines", "lines"),
        ("json", "Format JSON", "main"),
        ("base64-encode", "Encode Base64", "encoding"),
        ("base64-decode", "Decode Base64", "encoding"),
        ("url-encode", "Encode URL component", "encoding"),
        ("url-decode", "Decode URL component", "encoding"),
        ("count", "Count words", "main"),
    ]
    .into_iter()
    .map(|(id, name, group)| TextTool { id, name, group })
    .collect()
}
fn pretty_json(input: &str) -> Result<String> {
    // Validate without converting numbers to f64 or reordering object keys.
    serde_json::from_str::<serde::de::IgnoredAny>(input)
        .map_err(|_| msg("This text is not valid JSON"))?;
    let mut output = String::new();
    let mut quoted = false;
    let mut escaped = false;
    let mut depth = 0usize;
    let mut previous = None;
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if quoted {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quoted = false;
            }
        } else if !ch.is_ascii_whitespace() {
            match ch {
                '"' => {
                    quoted = true;
                    output.push(ch);
                }
                '{' | '[' => {
                    output.push(ch);
                    depth += 1;
                    if chars.clone().find(|c| !c.is_ascii_whitespace())
                        != Some(if ch == '{' { '}' } else { ']' })
                    {
                        output.push('\n');
                        output.push_str(&"  ".repeat(depth));
                    }
                }
                '}' | ']' => {
                    depth = depth.saturating_sub(1);
                    if previous != Some(if ch == '}' { '{' } else { '[' }) {
                        output.push('\n');
                        output.push_str(&"  ".repeat(depth));
                    }
                    output.push(ch);
                }
                ',' => {
                    output.push_str(",\n");
                    output.push_str(&"  ".repeat(depth));
                }
                ':' => output.push_str(": "),
                _ => output.push(ch),
            }
            previous = Some(ch);
        }
        if output.len() > LIMIT {
            return Err(msg("The formatted JSON exceeds the supported text limit"));
        }
    }
    Ok(output)
}
fn words(input: &str) -> Vec<String> {
    let chars: Vec<_> = input.chars().collect();
    let mut words = Vec::new();
    let mut word = String::new();
    for (i, &ch) in chars.iter().enumerate() {
        let boundary = !ch.is_alphanumeric()
            || (ch.is_uppercase()
                && i > 0
                && (chars[i - 1].is_lowercase()
                    || (chars[i - 1].is_uppercase()
                        && chars.get(i + 1).is_some_and(|next| next.is_lowercase()))));
        if boundary && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        if ch.is_alphanumeric() {
            word.push(ch);
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}
pub fn transform(id: &str, input: &str) -> Result<String> {
    if input.len() > LIMIT || input.contains('\0') {
        return Err(msg("Text exceeds the supported limit"));
    }
    let output = match id {
        "copy" | "plain" => input.to_owned(),
        "clean-link" => crate::notes::links::parse::clean_url(input)?,
        "upper" => input.to_uppercase(),
        "lower" => input.to_lowercase(),
        "title" => {
            let mut start = true;
            input
                .chars()
                .flat_map(|ch| {
                    let upper = start;
                    start = !ch.is_alphanumeric() && ch != '\'';
                    if upper {
                        ch.to_uppercase().collect::<Vec<_>>()
                    } else {
                        ch.to_lowercase().collect()
                    }
                })
                .collect()
        }
        "sentence" => {
            let mut start = true;
            input
                .chars()
                .flat_map(|ch| {
                    let upper = start && ch.is_alphabetic();
                    if ch.is_alphabetic() {
                        start = false;
                    }
                    if matches!(ch, '.' | '!' | '?' | '\n') {
                        start = true;
                    }
                    if upper {
                        ch.to_uppercase().collect::<Vec<_>>()
                    } else {
                        ch.to_lowercase().collect()
                    }
                })
                .collect()
        }
        "kebab" | "snake" => words(input)
            .iter()
            .map(|w| w.to_lowercase())
            .collect::<Vec<_>>()
            .join(if id == "kebab" { "-" } else { "_" }),
        "trim" => input.lines().map(str::trim).collect::<Vec<_>>().join("\n"),
        "sort" => {
            let mut lines: Vec<_> = input.lines().collect();
            lines.sort();
            lines.join("\n")
        }
        "dedupe" => {
            let mut seen = std::collections::HashSet::new();
            input
                .lines()
                .filter(|line| seen.insert(*line))
                .collect::<Vec<_>>()
                .join("\n")
        }
        "json" => pretty_json(input)?,
        "base64-encode" => STANDARD.encode(input),
        "base64-decode" => String::from_utf8(
            STANDARD
                .decode(input.trim())
                .map_err(|_| msg("This text is not valid Base64"))?,
        )
        .map_err(|_| msg("Decoded data is not UTF-8 text"))?,
        "url-encode" => input
            .as_bytes()
            .iter()
            .map(|&b| {
                if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect(),
        "url-decode" => {
            let bytes = input.as_bytes();
            let mut decoded = Vec::new();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%' {
                    let hex = bytes
                        .get(i + 1..i + 3)
                        .and_then(|b| std::str::from_utf8(b).ok())
                        .and_then(|h| u8::from_str_radix(h, 16).ok())
                        .ok_or_else(|| msg("This text has an invalid URL escape"))?;
                    decoded.push(hex);
                    i += 3;
                } else {
                    decoded.push(bytes[i]);
                    i += 1;
                }
            }
            String::from_utf8(decoded).map_err(|_| msg("Decoded data is not UTF-8 text"))?
        }
        "count" => format!(
            "{} words · {} characters · {} lines",
            input.split_whitespace().count(),
            input.chars().count(),
            input.lines().count()
        ),
        _ => return Err(msg("Unknown text tool")),
    };
    if output.len() > LIMIT || output.contains('\0') {
        return Err(msg("The result exceeds the supported text limit"));
    }
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transforms_cover_unicode_acronyms_lines_and_strict_encodings() {
        assert_eq!(transform("upper", "Straße বাংলা").unwrap(), "STRASSE বাংলা");
        assert_eq!(transform("title", "hELLO wORLD").unwrap(), "Hello World");
        assert_eq!(
            transform("sentence", "  hELLO. wORLD! AGAIN").unwrap(),
            "  Hello. World! Again"
        );
        assert_eq!(
            transform("kebab", "HTTPServer fooBar—বাংলা").unwrap(),
            "http-server-foo-bar-বাংলা"
        );
        assert_eq!(
            transform("snake", "HTTPServer fooBar").unwrap(),
            "http_server_foo_bar"
        );
        assert_eq!(transform("dedupe", "b\na\nb\n\n\n").unwrap(), "b\na\n");
        assert_eq!(transform("trim", " b \r\n a ").unwrap(), "b\na");
        assert_eq!(transform("sort", "b\na\nb").unwrap(), "a\nb\nb");
        for (encode, decode) in [
            ("base64-encode", "base64-decode"),
            ("url-encode", "url-decode"),
        ] {
            let text = "বাংলা + café / ?";
            assert_eq!(
                transform(decode, &transform(encode, text).unwrap()).unwrap(),
                text
            );
        }
        for (op, text) in [
            ("base64-decode", "/w=="),
            ("url-decode", "%FF"),
            ("url-decode", "%G0"),
            ("json", "{bad}"),
            ("no-such-tool", "x"),
        ] {
            assert!(transform(op, text).is_err());
        }
        assert_eq!(
            transform("count", "one দুই\nthree").unwrap(),
            "3 words · 13 characters · 2 lines"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &transform("json", "{\"b\":[1,true]}").unwrap()
            )
            .unwrap(),
            serde_json::json!({"b":[1,true]})
        );
        assert!(transform("upper", &"x".repeat(LIMIT + 1)).is_err());
    }
    #[test]
    fn catalog_ids_are_unique_and_all_run_without_side_effects() {
        let mut ids = std::collections::HashSet::new();
        for tool in catalog() {
            assert!(ids.insert(tool.id));
            let input = match tool.id {
                "json" => "{}",
                "base64-decode" => "aGk=",
                _ => "hello",
            };
            assert!(transform(tool.id, input).is_ok());
        }
    }
    #[test]
    fn json_formatting_preserves_number_lexemes_order_and_escaped_strings() {
        let input = r#"{"z":18446744073709551617,"a":[1.2300000000000000001,1e999,{},"x\\\"y"],"empty":[]}"#;
        let output = transform("json", input).unwrap();
        assert!(output.starts_with("{\n  \"z\": 18446744073709551617,\n  \"a\":"));
        assert!(output.contains("1.2300000000000000001"));
        assert!(output.contains("1e999"));
        assert!(output.contains("\"empty\": []"));
        assert!(serde_json::from_str::<serde::de::IgnoredAny>(&output).is_ok());
        assert_eq!(transform("json", "{}").unwrap(), "{}");
        assert_eq!(
            transform("json", r#"{"a":"} [ : ,", "b":true}"#).unwrap(),
            "{\n  \"a\": \"} [ : ,\",\n  \"b\": true\n}"
        );
    }
}
