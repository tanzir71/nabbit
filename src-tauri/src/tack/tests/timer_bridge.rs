//! Actual timer worker, scoped card store and activity arbitration with an injected UTC clock.
use crate::{
    db::Database,
    island::{
        activity::{Engine, Monitor, Preferences, Time},
        input::Gate,
    },
    notes::{store::NoteDraft, sync_store::Identity},
    timer::{self, Clock},
};
use serde_json::{json, Map, Value};
use std::sync::{
    atomic::{AtomicI64, Ordering},
    mpsc, Arc, Mutex, Weak,
};
pub(super) struct Fixture {
    service: Arc<timer::Service>,
    clock: Arc<timer::FixtureClock>,
    db: Database,
    engine: Arc<Mutex<Engine>>,
    events: Arc<Mutex<Vec<mpsc::Sender<String>>>>,
}
impl Fixture {
    pub fn new(db: Database, events: Arc<Mutex<Vec<mpsc::Sender<String>>>>) -> Self {
        let clock = Arc::new(timer::FixtureClock(AtomicI64::new(1_795_769_000_000)));
        let mut engine = Engine::new(Preferences::default());
        engine.monitors(
            vec![Monitor {
                label: "island".into(),
                monitor: "primary".into(),
                mode: Gate::Visible,
                base: Gate::Visible,
            }],
            Time::default(),
        );
        let engine = Arc::new(Mutex::new(engine));
        let observed = engine.clone();
        let output = events.clone();
        let weak = Arc::new(Mutex::new(Weak::<timer::Service>::new()));
        let weak_output = weak.clone();
        let time = clock.clone();
        let service=timer::Service::new(db.clone(),clock.clone(),Arc::new(move|snapshot,activity| {
            let mut packets=vec![json!({"event":"nabbit://timer","payload":snapshot})];
            let now=Time{mono_ms:0,unix_ms:time.now_ms()};let mut engine=observed.lock().unwrap();
            for event in activity {packets.push(json!({"event":"nabbit://activity","payload":engine.submit(event,None,now)}));}
            if let Some(service)=weak_output.lock().unwrap().upgrade(){service.observe(&engine.snapshot());}drop(engine);
            let data=packets.into_iter().map(|p|format!("data: {p}\n\n")).collect::<String>();output.lock().unwrap().retain(|s|s.send(data.clone()).is_ok());
        })).unwrap();
        *weak.lock().unwrap() = Arc::downgrade(&service);
        Self {
            service,
            clock,
            db,
            engine,
            events,
        }
    }
    pub fn route(
        &self,
        command: &str,
        mut args: Map<String, Value>,
    ) -> crate::tack::model::Result<Value> {
        let result = (|| -> Result<Value, String> {
            match command {
                "timer_snapshot" => Ok(json!(self.service.read()?)),
                "timer_action" => Ok(json!(self.service.action(
                    serde_json::from_value(args.remove("request").unwrap_or(Value::Null))
                        .map_err(|e| e.to_string())?
                )?)),
                "timer_view" => {
                    self.service.viewer(
                        "island".into(),
                        args.get("lease")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .into(),
                        args.get("active").and_then(Value::as_bool).unwrap_or(false),
                    );
                    Ok(Value::Null)
                }
                "timer_fixture" | "test.timer" => {
                    if args.get("prepare").and_then(Value::as_bool) == Some(true) {
                        let scope = self
                            .db
                            .tack_activate(&Identity {
                                base_url: "https://fixture.invalid/timer/".into(),
                                user_id: "timer-fixture".into(),
                                workspace_id: "one".into(),
                            })
                            .map_err(|e| e.to_string())?;
                        let card = self
                            .db
                            .create_note_card_in(
                                NoteDraft {
                                    title: "Island window spike".into(),
                                    ..Default::default()
                                },
                                Some(&scope),
                            )
                            .map_err(|e| e.to_string())?;
                        let mut value = card.value;
                        value["ref"] = json!("tck-24");
                        self.db
                            .conn
                            .lock()
                            .unwrap()
                            .execute(
                                "UPDATE note_cards SET value=?1 WHERE id=?2",
                                rusqlite::params![value.to_string(), value["id"].as_str().unwrap()],
                            )
                            .unwrap();
                    }
                    if args.get("switchWorkspace").and_then(Value::as_bool) == Some(true) {
                        self.db
                            .tack_activate(&Identity {
                                base_url: "https://fixture.invalid/timer/".into(),
                                user_id: "timer-fixture".into(),
                                workspace_id: "two".into(),
                            })
                            .map_err(|e| e.to_string())?;
                    }
                    if let Some(now) = args.get("nowMs").and_then(Value::as_i64) {
                        self.clock.0.store(now, Ordering::Relaxed);
                    }
                    if args.contains_key("hidden") || args.contains_key("alerts") {
                        let mut engine = self.engine.lock().unwrap();
                        let mut preferences = engine.preferences.clone();
                        if let Some(alerts) = args.get("alerts").and_then(Value::as_bool) {
                            preferences.show_alerts_over_fullscreen = alerts;
                        }
                        let now = Time {
                            mono_ms: 0,
                            unix_ms: self.clock.now_ms(),
                        };
                        engine.submit(
                            crate::island::activity::ActivityEvent::PreferencesChanged {
                                preferences,
                            },
                            None,
                            now,
                        );
                        let mode = if args.get("hidden").and_then(Value::as_bool) == Some(true) {
                            Gate::Hidden
                        } else {
                            Gate::Visible
                        };
                        engine.monitors(
                            vec![Monitor {
                                label: "island".into(),
                                monitor: "primary".into(),
                                mode,
                                base: mode,
                            }],
                            now,
                        );
                        let snapshot = engine.snapshot();
                        self.service.observe(&snapshot);
                        let data = format!(
                            "data: {}\n\n",
                            json!({"event":"nabbit://activity","payload":{"kind":"refresh","target":null,"snapshot":snapshot}})
                        );
                        self.events
                            .lock()
                            .unwrap()
                            .retain(|s| s.send(data.clone()).is_ok());
                    }
                    self.service.wake();
                    let snapshot = self.service.read()?;
                    if command == "timer_fixture" {
                        return Ok(json!(snapshot));
                    }
                    let conn = self.db.conn.lock().unwrap();
                    let history=conn.prepare("SELECT id,card_id,ended_at,outcome,phase FROM focus_sessions ORDER BY started_at,id").unwrap().query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"cardId":r.get::<_,Option<String>>(1)?,"endedAt":r.get::<_,Option<String>>(2)?,"outcome":r.get::<_,String>(3)?,"phase":r.get::<_,String>(4)?}))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
                    let queued: i64 = conn
                        .query_row("SELECT count(*) FROM tack_outbox", [], |r| r.get(0))
                        .unwrap();
                    drop(conn);
                    Ok(
                        json!({"snapshot":snapshot,"history":history,"outboxCount":queued,"cards":self.db.notes_state().map_err(|e|e.to_string())?.cards,"activity":self.engine.lock().unwrap().snapshot()}),
                    )
                }
                _ => Err("Unknown timer bridge command".into()),
            }
        })();
        result.map_err(|_| {
            crate::tack::model::Error::new(crate::tack::model::ErrorCode::InvalidInput)
        })
    }
}
