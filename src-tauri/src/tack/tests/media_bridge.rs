//! Production media service and activity arbitration with recorded hardware only.
use crate::{
    island::{
        activity::{Engine, Monitor, Preferences, Time},
        input::Gate,
    },
    media,
};
use serde_json::{json, Map, Value};
use std::sync::{mpsc, Arc, Mutex};
pub(super) struct Fixture {
    pub service: Arc<media::Service>,
    provider: Arc<media::recorded::Recorded>,
}
impl Fixture {
    pub fn new(events: Arc<Mutex<Vec<mpsc::Sender<String>>>>) -> Self {
        let provider = Arc::new(media::recorded::Recorded::default());
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
        let engine = Mutex::new(engine);
        let service = media::Service::new(
            provider.clone(),
            Arc::new(move |snapshot, activity| {
                let mut packets = vec![json!({"event":"nabbit://media","payload":snapshot})];
                for event in activity {
                    let message = engine.lock().unwrap().submit(event, None, Time::default());
                    packets.push(json!({"event":"nabbit://activity","payload":message}));
                }
                let data = packets
                    .into_iter()
                    .map(|p| format!("data: {p}\n\n"))
                    .collect::<String>();
                events
                    .lock()
                    .unwrap()
                    .retain(|s| s.send(data.clone()).is_ok());
            }),
        );
        Self { service, provider }
    }
    pub fn route(
        &self,
        command: &str,
        mut args: Map<String, Value>,
    ) -> crate::tack::model::Result<Value> {
        let result = (|| -> Result<Value, String> {
            match command {
                "media_snapshot" => Ok(json!(self.service.snapshot())),
                "media_select" => {
                    self.service
                        .select(args.get("id").and_then(Value::as_str).unwrap_or("").into())?;
                    Ok(Value::Null)
                }
                "media_action" => {
                    self.service.perform(
                        serde_json::from_value(args.remove("action").unwrap_or(Value::Null))
                            .map_err(|e| e.to_string())?,
                    )?;
                    Ok(Value::Null)
                }
                "media_toggle" => {
                    self.service.toggle()?;
                    Ok(Value::Null)
                }
                "test.media" => {
                    if let Some(snapshot) = args.remove("snapshot") {
                        self.provider
                            .replace(serde_json::from_value(snapshot).map_err(|e| e.to_string())?);
                    }
                    if args.get("resume").and_then(Value::as_bool) == Some(true) {
                        self.service.resume();
                    }
                    Ok(json!({"snapshot":self.service.snapshot(),"audit":self.provider.audit()}))
                }
                _ => Err("Unknown media bridge command".into()),
            }
        })();
        result.map_err(|_| {
            crate::tack::model::Error::new(crate::tack::model::ErrorCode::InvalidInput)
        })
    }
}
