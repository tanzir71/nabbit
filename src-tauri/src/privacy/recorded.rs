//! Recording provider for owned acceptance sessions. Production never selects it.
use super::*;
#[derive(Default)]
pub struct Recorded {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    sink: Option<Sink>,
    value: Option<Result<model::RegistrySnapshot, String>>,
    subscriptions: u32,
    resumes: u32,
    stops: u32,
}
impl Recorded {
    pub fn replace(&self, value: Result<model::RegistrySnapshot, String>) {
        let sink = {
            let mut s = self.state.lock().unwrap();
            s.value = Some(value.clone());
            s.sink.clone()
        };
        if let Some(sink) = sink {
            sink(value);
        }
    }
    pub fn audit(&self) -> serde_json::Value {
        let s = self.state.lock().unwrap();
        serde_json::json!({"subscriptions":s.subscriptions,"resumes":s.resumes,"stops":s.stops,"polls":0})
    }
}
impl PrivacyProvider for Recorded {
    fn subscribe(&self, sink: Sink) -> Result<(), String> {
        let value = {
            let mut s = self.state.lock().unwrap();
            if s.sink.is_some() {
                return Err("Already subscribed".into());
            }
            s.subscriptions += 1;
            s.sink = Some(sink.clone());
            s.value.clone().unwrap_or_else(|| Ok(Default::default()))
        };
        sink(value);
        Ok(())
    }
    fn resume(&self) {
        let value = {
            let mut s = self.state.lock().unwrap();
            s.resumes += 1;
            s.value.clone().unwrap_or_else(|| Ok(Default::default()))
        };
        self.replace(value);
    }
    fn stop(&self) {
        let mut s = self.state.lock().unwrap();
        s.stops += 1;
        s.sink = None;
    }
}
