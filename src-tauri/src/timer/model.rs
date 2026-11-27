//! UTC deadlines are authoritative; display ticks never mutate persisted time.
use crate::notes::sync_store::Context;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardLink {
    pub id: String,
    pub expected_scope: Option<Context>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub preset: String,
    pub focus_s: u32,
    pub break_s: u32,
    pub rounds: u8,
    pub label: String,
    pub card: Option<CardLink>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            preset: "25/5".into(),
            focus_s: 1500,
            break_s: 300,
            rounds: 4,
            label: "Focus".into(),
            card: None,
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        let fixed = match self.preset.as_str() {
            "25/5" => Some((1500, 300, 4)),
            "50/10" => Some((3000, 600, 4)),
            "90" => Some((5400, 0, 1)),
            "custom" => None,
            _ => return Err("Unknown timer preset.".into()),
        };
        if fixed.is_some_and(|v| v != (self.focus_s, self.break_s, self.rounds))
            || !(60..=86400).contains(&self.focus_s)
            || self.break_s > 7200
            || !(1..=12).contains(&self.rounds)
            || self.label.trim().is_empty()
            || self.label.chars().count() > 80
        {
            return Err("Use 1–1440 focus minutes, 0–120 break minutes and 1–12 rounds.".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Focus,
    Break,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Running,
    Paused,
    Ended,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub phase: Phase,
    pub status: Status,
    pub round: u8,
    pub started_at_ms: i64,
    pub planned_s: u32,
    pub remaining_ms: i64,
    pub deadline_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
}
impl Session {
    pub fn remaining_ms(&self, now: i64) -> i64 {
        match self.status {
            Status::Running => self.deadline_ms.unwrap_or(now).saturating_sub(now).max(0),
            Status::Paused => self.remaining_ms,
            Status::Ended => 0,
        }
    }
    pub fn remaining_s(&self, now: i64) -> u32 {
        (self.remaining_ms(now).saturating_add(999) / 1000).min(i64::from(u32::MAX)) as u32
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub generation: u64,
    pub config: Config,
    pub session: Option<Session>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Start,
    Pause,
    Resume,
    Stop,
    Configure { config: Config },
    Link { card: Option<CardLink> },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub expected_generation: u64,
    pub action: Action,
}
impl Model {
    /// Completion is persisted once at its original UTC deadline, including after restart.
    pub fn advance(&mut self, now: i64) -> Option<String> {
        let s = self.session.as_mut()?;
        if s.status != Status::Running || s.deadline_ms? > now {
            return None;
        }
        s.status = Status::Ended;
        s.remaining_ms = 0;
        s.ended_at_ms = s.deadline_ms.take();
        self.generation += 1;
        Some(s.id.clone())
    }
    pub fn apply(
        &mut self,
        action: Action,
        now: i64,
        id: impl FnOnce() -> String,
    ) -> Result<(), String> {
        match action {
            Action::Configure { config } => {
                config.validate()?;
                self.config = config;
                self.session = None;
            }
            Action::Link { card } => self.config.card = card,
            Action::Stop => self.session = None,
            Action::Pause => {
                let s = self.session.as_mut().ok_or("No timer is running.")?;
                if s.status != Status::Running {
                    return Err("The timer is not running.".into());
                }
                s.remaining_ms = s.remaining_ms(now);
                s.deadline_ms = None;
                s.status = Status::Paused;
            }
            Action::Resume => {
                let s = self.session.as_mut().ok_or("No paused timer.")?;
                if s.status != Status::Paused {
                    return Err("The timer is not paused.".into());
                }
                s.deadline_ms = Some(
                    now.checked_add(s.remaining_ms)
                        .ok_or("Invalid timer date.")?,
                );
                s.status = Status::Running;
            }
            Action::Start => {
                self.config.validate()?;
                let (phase, round) = match self.session.as_ref() {
                    Some(s) if s.status != Status::Ended => {
                        return Err("Stop or pause the active timer first.".into())
                    }
                    Some(s)
                        if s.phase == Phase::Focus
                            && self.config.break_s > 0
                            && s.round < self.config.rounds =>
                    {
                        (Phase::Break, s.round)
                    }
                    Some(s) if s.round < self.config.rounds => (Phase::Focus, s.round + 1),
                    _ => (Phase::Focus, 1),
                };
                let planned_s = if phase == Phase::Focus {
                    self.config.focus_s
                } else {
                    self.config.break_s
                };
                let remaining_ms = i64::from(planned_s) * 1000;
                self.session = Some(Session {
                    id: id(),
                    phase,
                    status: Status::Running,
                    round,
                    started_at_ms: now,
                    planned_s,
                    remaining_ms,
                    deadline_ms: Some(now.checked_add(remaining_ms).ok_or("Invalid timer date.")?),
                    ended_at_ms: None,
                });
            }
        }
        self.generation += 1;
        Ok(())
    }
    pub fn toggle_action(&self) -> Action {
        match self.session.as_ref().map(|s| s.status) {
            Some(Status::Running) => Action::Pause,
            Some(Status::Paused) => Action::Resume,
            _ => Action::Start,
        }
    }
    pub fn wait_ms(&self, now: i64, visible: bool) -> Option<u64> {
        let s = self
            .session
            .as_ref()
            .filter(|s| s.status == Status::Running)?;
        let remaining = s.remaining_ms(now) as u64;
        if remaining == 0 {
            return Some(0);
        }
        // Hidden/queued timers sleep until end. A visible countdown wakes on its next boundary.
        Some(if visible {
            ((remaining - 1) % 1000 + 1).min(remaining)
        } else {
            remaining
        })
    }
}
