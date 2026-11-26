//! Estimates from the probe JSON, without exposing signed media stream URLs.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QualityEstimate {
    pub height: u16,
    pub estimated_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<u16>,
}
fn bytes(value: &Value, duration: Option<f64>) -> Option<u64> {
    value
        .get("filesize")
        .and_then(Value::as_u64)
        .or_else(|| value.get("filesize_approx").and_then(Value::as_u64))
        .filter(|n| *n > 0)
        .or_else(|| {
            let size = value.get("tbr")?.as_f64()? * 1000.0 / 8.0 * duration?;
            (size.is_finite() && size > 0.0 && size < (u64::MAX as f64))
                .then_some(size.ceil() as u64)
        })
}
pub fn from_probe(value: &Value) -> Vec<QualityEstimate> {
    let Some(formats) = value.get("formats").and_then(Value::as_array) else {
        return vec![];
    };
    let duration = value
        .get("duration")
        .and_then(Value::as_f64)
        .filter(|d| d.is_finite() && *d > 0.0);
    let audio = formats
        .iter()
        .filter(|f| {
            f.get("has_drm").and_then(Value::as_bool) != Some(true)
                && f.get("vcodec").and_then(Value::as_str) == Some("none")
                && f.get("acodec")
                    .and_then(Value::as_str)
                    .is_some_and(|v| v != "none")
        })
        .filter_map(|f| bytes(f, duration))
        .max();
    let mut heights: BTreeMap<u16, Option<u64>> = BTreeMap::new();
    for f in formats {
        if f.get("has_drm").and_then(Value::as_bool) == Some(true)
            || matches!(
                f.get("vcodec").and_then(Value::as_str),
                Some("none" | "images")
            )
        {
            continue;
        }
        let Some(height) = f
            .get("height")
            .and_then(Value::as_u64)
            .and_then(|h| u16::try_from(h).ok())
            .filter(|h| *h > 0)
        else {
            continue;
        };
        let size = if f
            .get("acodec")
            .and_then(Value::as_str)
            .is_some_and(|v| v != "none")
        {
            bytes(f, duration)
        } else {
            bytes(f, duration).and_then(|n| n.checked_add(audio?))
        };
        heights
            .entry(height)
            .and_modify(|prior| *prior = (*prior).max(size))
            .or_insert(size);
    }
    heights
        .into_iter()
        .rev()
        .map(|(height, estimated_bytes)| QualityEstimate {
            height,
            estimated_bytes,
            fps: formats
                .iter()
                .filter(|f| {
                    f.get("height").and_then(Value::as_u64) == Some(height as u64)
                        && f.get("has_drm").and_then(Value::as_bool) != Some(true)
                        && !matches!(
                            f.get("vcodec").and_then(Value::as_str),
                            Some("none" | "images")
                        )
                })
                .filter_map(|f| {
                    f.get("fps")
                        .and_then(Value::as_f64)
                        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 480.0)
                        .map(|n| n.round() as u16)
                })
                .max(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_rates_come_from_matching_non_drm_video_formats() {
        let data = serde_json::json!({"formats":[{"height":1080,"vcodec":"av1","acodec":"aac","fps":59.94,"filesize":42},{"height":1080,"vcodec":"av1","has_drm":true,"fps":120},{"height":90,"vcodec":"images","fps":300}]});
        let quality = from_probe(&data);
        assert_eq!(quality.len(), 1);
        assert_eq!(quality[0].fps, Some(60));
    }
    #[test]
    fn exact_approximate_and_bitrate_sizes_include_audio_and_keep_unknowns() {
        let value = serde_json::json!({"duration":8,"formats":[
            {"height":1080,"vcodec":"av1","acodec":"none","filesize":1000},
            {"height":720,"vcodec":"h264","acodec":"aac","filesize_approx":700},
            {"height":480,"vcodec":"h264","acodec":"none","tbr":1.0},
            {"height":240,"vcodec":"h264","acodec":"none"},
            {"height":90,"vcodec":"images","filesize":20},
            {"height":2160,"vcodec":"h264","filesize":9999,"has_drm":true},
            {"vcodec":"none","acodec":"aac","filesize":100},
            {"vcodec":"none","acodec":"opus","filesize":200}
        ]});
        assert_eq!(
            from_probe(&value),
            vec![
                QualityEstimate {
                    height: 1080,
                    estimated_bytes: Some(1200),
                    fps: None,
                },
                QualityEstimate {
                    height: 720,
                    estimated_bytes: Some(700),
                    fps: None,
                },
                QualityEstimate {
                    height: 480,
                    estimated_bytes: Some(1200),
                    fps: None,
                },
                QualityEstimate {
                    height: 240,
                    estimated_bytes: None,
                    fps: None,
                }
            ]
        );
    }
    #[test]
    fn missing_audio_or_bad_duration_never_fabricates_a_total() {
        let value = serde_json::json!({"duration":-1,"formats":[{"height":1080,"vcodec":"av1","acodec":"none","filesize":1000},{"height":720,"vcodec":"h264","acodec":"aac","tbr":20}]});
        assert!(from_probe(&value)
            .iter()
            .all(|q| q.estimated_bytes.is_none()));
        assert!(from_probe(&serde_json::json!({})).is_empty());
    }
}
