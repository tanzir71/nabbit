//! Injected hardware seam for automated, isolated acceptance sessions only.
use super::*;
#[derive(Default)]
pub struct Recorded {
    operation: Mutex<()>,
    state: Mutex<Snapshot>,
    sink: Mutex<Option<Sink>>,
    actions: Mutex<Vec<Action>>,
    lifecycle: Mutex<Vec<&'static str>>,
}
impl Recorded {
    pub fn replace(&self, snapshot: Snapshot) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = snapshot.clone();
        let sink = self.sink.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(sink) = sink {
            sink(snapshot);
        }
    }
    pub fn audit(&self) -> serde_json::Value {
        serde_json::json!({"actions":*self.actions.lock().unwrap_or_else(|e|e.into_inner()),"lifecycle":*self.lifecycle.lock().unwrap_or_else(|e|e.into_inner()),"polls":0,"hardwareCalls":0})
    }
}
impl MediaProvider for Recorded {
    fn subscribe(&self, sink: Sink) -> Result<(), String> {
        let mut current = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        if current.is_some() {
            return Err("Already subscribed".into());
        }
        *current = Some(sink.clone());
        drop(current);
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push("subscribe");
        sink(self.state.lock().unwrap_or_else(|e| e.into_inner()).clone());
        Ok(())
    }
    fn perform(&self, action: Action) -> Result<(), String> {
        let _operation = self.operation.lock().unwrap_or_else(|e| e.into_inner());
        let mut snapshot = self.state.lock().unwrap_or_else(|e| e.into_inner()).clone();
        validate(&snapshot, &action)?;
        self.actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(action.clone());
        match action {
            Action::VolumeStep { direction, fine } => {
                let v = snapshot.volume.as_mut().unwrap();
                v.percent = stepped_volume(v.percent, direction, fine);
            }
            Action::Volume { percent } => snapshot.volume.as_mut().unwrap().percent = percent,
            Action::Mute { muted } => snapshot.volume.as_mut().unwrap().muted = muted,
            Action::Toggle { id } => {
                let s = snapshot.sessions.iter_mut().find(|s| s.id == id).unwrap();
                s.playing = !s.playing;
            }
            Action::Seek { id, position_s } => {
                snapshot
                    .sessions
                    .iter_mut()
                    .find(|s| s.id == id)
                    .unwrap()
                    .timeline
                    .as_mut()
                    .unwrap()
                    .position_s = position_s
            }
            Action::Previous { .. } | Action::Next { .. } => {}
        }
        self.replace(snapshot);
        Ok(())
    }
    fn resume(&self) {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(["unsubscribe", "subscribe"]);
    }
    fn stop(&self) {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push("unsubscribe");
        self.sink.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}
