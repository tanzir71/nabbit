//! Compact drawing data is regenerated on activity/configuration changes only.
use super::{
    activity::{ActivityEvent as Event, Item, View},
    model::Shape,
};
use serde::Serialize;
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Draw {
    Level {
        x: f32,
        width: f32,
        value: f32,
    },
    Text {
        value: String,
        x: f32,
        width: f32,
        mono: bool,
        strong: bool,
        muted: bool,
    },
    Icon {
        name: &'static str,
        x: f32,
    },
    Ring {
        value: f32,
        x: f32,
    },
    Button {
        label: &'static str,
        x: f32,
        width: f32,
        signal: bool,
    },
    Artwork {
        x: f32,
        art: Option<String>,
    },
    Bars {
        x: f32,
        playing: bool,
    },
    Dot {
        x: f32,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compact {
    pub width: f32,
    pub primary_width: f32,
    pub height: f32,
    pub top: f32,
    pub radius: f32,
    pub notch: bool,
    pub primary: Vec<Draw>,
    pub bubble: Vec<Draw>,
    pub alert: Option<String>,
}
fn filename(value: &str) -> &str {
    value.rsplit(['\\', '/']).next().unwrap_or(value)
}
fn time(value: u32) -> String {
    format!("{}:{:02}", value / 60, value % 60)
}
fn percentage(value: f64) -> String {
    format!("{}%", value.clamp(0.0, 100.0).round())
}
fn text(
    value: impl Into<String>,
    x: f32,
    width: f32,
    mono: bool,
    strong: bool,
    muted: bool,
) -> Draw {
    Draw::Text {
        value: value.into(),
        x,
        width,
        mono,
        strong,
        muted,
    }
}
fn icon(name: &'static str, x: f32) -> Draw {
    Draw::Icon { name, x }
}
fn button(label: &'static str, x: f32, width: f32, signal: bool) -> Draw {
    Draw::Button {
        label,
        x,
        width,
        signal,
    }
}
fn normal_width(event: &Event) -> f32 {
    match event {
        Event::VolumeChanged { .. } => 272.0,
        Event::LinkDetected { .. } => 336.0,
        Event::DownloadProgress { .. } => 320.0,
        Event::MediaChanged { .. } | Event::NoteSaved { .. } | Event::LinkSaved { .. } => 272.0,
        Event::TimerTick { .. } | Event::TimerPaused { .. } | Event::TimerEnded { .. } => 240.0,
        Event::PrivacyChanged { .. } | Event::PowerChanged { .. } => 232.0,
        Event::DownloadDone { .. } | Event::DownloadFailed { .. } => 348.0,
        Event::FilesMoved { .. } => 312.0,
        Event::ToolResult { .. } => 340.0,
        Event::ToolJob { .. } => 300.0,
        _ => 112.0,
    }
}
fn draw(item: &Item, width: f32) -> Vec<Draw> {
    let right = width - 10.0;
    match &item.event {
        Event::VolumeChanged { percent, muted } => vec![
            icon("iconVolume2", 10.0),
            Draw::Level {
                x: 34.0,
                width: width - 70.0,
                value: if *muted { 0.0 } else { *percent as f32 },
            },
            text(percent.to_string(), width - 28.0, 18.0, true, false, true),
        ],
        Event::DownloadProgress { title, percent, .. } => vec![
            Draw::Ring {
                value: *percent as f32,
                x: 10.0,
            },
            text(title, 36.0, width - 86.0, false, false, true),
            text(percentage(*percent), right - 32.0, 32.0, true, false, false),
        ],
        Event::ToolJob { label, percent, .. } => vec![
            Draw::Ring {
                value: *percent as f32,
                x: 10.0,
            },
            text(label, 36.0, width - 86.0, false, false, true),
            text(percentage(*percent), right - 32.0, 32.0, true, false, false),
        ],
        Event::LinkDetected {
            duration,
            title,
            site,
            ..
        } => {
            let mut result = vec![
                icon("iconLink", 10.0),
                text(
                    if title.is_some() {
                        "Video link copied"
                    } else {
                        site
                    },
                    34.0,
                    108.0,
                    false,
                    true,
                    false,
                ),
                button("Nab it", right - 69.0, 69.0, true),
            ];
            if let Some(seconds) = duration {
                result.push(text(
                    time(*seconds),
                    150.0,
                    (width - 239.0).max(0.0),
                    true,
                    false,
                    true,
                ));
            }
            result
        }
        Event::MediaChanged { playing, art, .. } => vec![
            Draw::Artwork {
                x: 10.0,
                art: art.clone(),
            },
            Draw::Bars {
                x: right - 23.0,
                playing: *playing,
            },
        ],
        Event::TimerTick {
            remaining_s, label, ..
        }
        | Event::TimerPaused {
            remaining_s, label, ..
        } => vec![
            icon("iconTimer", 10.0),
            text(
                if matches!(&item.event, Event::TimerPaused { .. }) {
                    "Paused"
                } else {
                    label
                },
                34.0,
                width - 98.0,
                false,
                false,
                true,
            ),
            text(time(*remaining_s), right - 43.0, 43.0, true, false, false),
        ],
        Event::TimerEnded { .. } => vec![
            icon("iconTimer", 10.0),
            text("Time is up", 34.0, width - 98.0, false, false, true),
            text("0:00", right - 36.0, 36.0, true, false, false),
        ],
        Event::PrivacyChanged { mic, camera } => {
            let mut names = mic.clone();
            for name in camera {
                if !names.contains(name) {
                    names.push(name.clone());
                }
            }
            vec![
                icon("iconMic", 10.0),
                text(names.join(", "), 34.0, width - 62.0, false, false, true),
                Draw::Dot { x: right - 8.0 },
            ]
        }
        Event::PowerChanged { percent, charging } => vec![
            icon("iconBatteryCharging", 10.0),
            text(
                if *charging { "Charging" } else { "Battery low" },
                34.0,
                width - 98.0,
                false,
                false,
                true,
            ),
            text(
                format!("{percent}%"),
                right - 32.0,
                32.0,
                true,
                false,
                false,
            ),
        ],
        Event::DownloadDone { path, .. } => vec![
            icon("iconCircleCheck", 10.0),
            text("Saved", 34.0, 34.0, false, true, false),
            text(filename(path), 76.0, width - 143.0, false, false, true),
            button("Open", right - 47.0, 47.0, false),
        ],
        Event::DownloadFailed { job_id, error } => vec![
            icon("iconTriangleAlert", 10.0),
            text(
                if job_id == crate::download::engine::HEALTH_JOB {
                    "Download engine needs an update"
                } else {
                    error.compact_title()
                },
                34.0,
                width - 100.0,
                false,
                false,
                false,
            ),
            button("Fix", right - 51.0, 51.0, false),
        ],
        Event::NoteSaved { destination, .. } => vec![
            icon("iconStickyNote", 10.0),
            text(
                format!(
                    "Saved {} {destination}",
                    if destination.starts_with("this PC") {
                        "on"
                    } else {
                        "to"
                    }
                ),
                34.0,
                width - 67.0,
                false,
                false,
                false,
            ),
            icon("iconCheck", right - 15.0),
        ],
        Event::LinkSaved { title, .. } => vec![
            icon("iconStickyNote", 10.0),
            text(
                format!("Saved {title}"),
                34.0,
                width - 67.0,
                false,
                false,
                false,
            ),
            icon("iconCheck", right - 15.0),
        ],
        Event::FilesMoved {
            count,
            destination,
            undoable,
            verb,
            ..
        } => {
            let caption = if *verb == super::activity::MoveVerb::Copied {
                "Copied"
            } else {
                "Moved"
            };
            let mut result = vec![
                icon("iconFolderInput", 10.0),
                text(
                    format!("{caption} to {}", filename(destination)),
                    34.0,
                    width - 160.0,
                    false,
                    true,
                    false,
                ),
                text(
                    format!("{count} files"),
                    width - 118.0,
                    56.0,
                    true,
                    false,
                    true,
                ),
            ];
            if *undoable {
                result.push(button("Undo", right - 46.0, 46.0, false));
            }
            result
        }
        Event::ToolResult {
            path,
            before_bytes,
            after_bytes,
            note,
            ..
        } => vec![
            icon("iconFileVideo", 10.0),
            text(
                format!(
                    "{} {} MB → {} MB",
                    filename(path),
                    *before_bytes as f64 / 1e6,
                    *after_bytes as f64 / 1e6
                ),
                34.0,
                width - 142.0,
                true,
                false,
                false,
            ),
            text(
                note.clone().unwrap_or_default(),
                width - 96.0,
                70.0,
                false,
                false,
                true,
            ),
            icon("iconCheck1", right - 14.0),
        ],
        _ => vec![],
    }
}
fn bubble(item: &Item) -> Vec<Draw> {
    match &item.event {
        Event::VolumeChanged { .. } => vec![icon("iconVolume2", 8.0)],
        Event::DownloadProgress { percent, .. } | Event::ToolJob { percent, .. } => {
            vec![Draw::Ring {
                value: *percent as f32,
                x: 7.0,
            }]
        }
        Event::TimerTick { .. } | Event::TimerPaused { .. } | Event::TimerEnded { .. } => {
            vec![icon("iconTimer1", 8.5)]
        }
        Event::LinkDetected { .. } => vec![icon("iconLink", 8.0)],
        Event::PrivacyChanged { .. } => vec![icon("iconMic", 8.0)],
        Event::MediaChanged { .. } => vec![icon("iconVolume2", 8.0)],
        Event::PowerChanged { .. } => vec![icon("iconBatteryCharging", 8.0)],
        Event::DownloadDone { .. } => vec![icon("iconCircleCheck", 8.0)],
        Event::DownloadFailed { .. } => vec![icon("iconTriangleAlert", 8.0)],
        Event::FilesMoved { .. } => vec![icon("iconFolderInput", 8.0)],
        Event::ToolResult { .. } => vec![icon("iconFileVideo", 8.0)],
        _ => vec![icon("iconStickyNote", 8.0)],
    }
}
pub fn compact(view: Option<&View>, shape: Shape) -> Compact {
    let primary = view.and_then(|view| view.primary.as_ref());
    let secondary = view.and_then(|view| view.bubble.as_ref());
    let width = primary
        .map(|item| {
            if secondary.is_some() {
                260.0
            } else {
                normal_width(&item.event)
            }
        })
        .unwrap_or(if shape == Shape::Notch { 168.0 } else { 112.0 });
    let mut primary_draws = primary
        .map(|item| draw(item, width - if shape == Shape::Notch { 8.0 } else { 0.0 }))
        .unwrap_or_default();
    if shape == Shape::Notch {
        for command in &mut primary_draws {
            match command {
                Draw::Text { x, .. }
                | Draw::Icon { x, .. }
                | Draw::Ring { x, .. }
                | Draw::Button { x, .. }
                | Draw::Artwork { x, .. }
                | Draw::Bars { x, .. }
                | Draw::Dot { x, .. }
                | Draw::Level { x, .. } => *x += 4.0,
            }
        }
    }
    Compact {
        width: width + if secondary.is_some() { 38.0 } else { 0.0 },
        primary_width: width,
        height: if primary.is_some() {
            32.0
        } else if shape == Shape::Notch {
            24.0
        } else {
            26.0
        },
        top: if shape == Shape::Notch { 0.0 } else { 6.0 },
        radius: if primary.is_some() {
            16.0
        } else if shape == Shape::Notch {
            12.0
        } else {
            13.0
        },
        notch: shape == Shape::Notch,
        primary: primary_draws,
        bubble: secondary.map(bubble).unwrap_or_default(),
        alert: primary
            .filter(|item| item.alert)
            .map(|item| item.id.clone()),
    }
}
#[cfg(test)]
mod capture_tests {
    use super::*;
    #[test]
    fn saved_note_reports_local_durability_in_the_existing_compact_slot() {
        let item = Item {
            id: "note:fixture".into(),
            category: super::super::activity::Kind::Result,
            event: Event::NoteSaved {
                card_id: "fixture".into(),
                destination: "this PC · Inbox".into(),
            },
            alert: false,
            bubble_only: false,
        };
        assert_eq!(normal_width(&item.event), 272.0);
        let draws = draw(&item, 272.0);
        assert!(draws
            .iter()
            .any(|d| matches!(d,Draw::Text{value,..} if value=="Saved on this PC · Inbox")));
        assert!(draws.iter().any(|d| matches!(
            d,
            Draw::Icon {
                name: "iconStickyNote",
                ..
            }
        )));
        assert!(draws.iter().any(|d| matches!(
            d,
            Draw::Icon {
                name: "iconCheck",
                ..
            }
        )));
    }
}
