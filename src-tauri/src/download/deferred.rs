//! Deferred recovery sleeps indefinitely without pending jobs. Only Rust wakes it.
use std::{
    collections::BTreeMap,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Scheduler {
    state: Mutex<State>,
    wake: Condvar,
}
#[derive(Default)]
struct State {
    due: BTreeMap<String, Instant>,
    stopped: bool,
}
impl Scheduler {
    pub fn schedule(&self, id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .due
            .insert(id.into(), Instant::now() + Duration::from_secs(30));
        self.wake.notify_one();
    }
    pub fn remove(&self, id: &str) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .due
            .remove(id);
        self.wake.notify_one();
    }
    pub fn stop(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
        self.wake.notify_one();
    }
    pub fn next(&self) -> Option<Vec<String>> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if state.stopped {
                return None;
            }
            let now = Instant::now();
            let ready = take_due(&mut state.due, now);
            if !ready.is_empty() {
                return Some(ready);
            }
            state = match state
                .due
                .values()
                .min()
                .map(|due| due.saturating_duration_since(now))
            {
                Some(due) => {
                    self.wake
                        .wait_timeout(state, due)
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
                None => self.wake.wait(state).unwrap_or_else(|e| e.into_inner()),
            };
        }
    }
}
fn take_due(due: &mut BTreeMap<String, Instant>, now: Instant) -> Vec<String> {
    let ids = due
        .iter()
        .filter(|(_, t)| **t <= now)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for id in &ids {
        due.remove(id);
    }
    ids
}
pub fn online(url: &str) -> bool {
    // Any HTTP response proves connectivity, including an origin's 403/405.
    // No cookies, response body, external connectivity service or media transfer.
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .and_then(|client| client.head(url).send())
        .is_ok()
}
pub fn eligible(job: &crate::db::models::DownloadJob) -> bool {
    job.status == "failed"
        && match super::errors::classify(job.error.as_deref().unwrap_or_default()) {
            super::errors::ErrorKind::Offline => true,
            super::errors::ErrorKind::Live => {
                job.options.as_ref().is_some_and(|o| o.wait_for_video)
            }
            _ => false,
        }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connectivity_uses_head_only_and_accepts_a_forbidden_origin_response() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                assert!(request.len() < 8192);
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("HEAD /watch "));
            assert!(!request.to_lowercase().contains("cookie:"));
            stream
                .write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        assert!(online(&format!("http://{address}/watch")));
        server.join().unwrap();
        assert!(!online(&format!("http://{address}/watch")));
    }
    #[test]
    fn deadlines_cancel_and_rearm_without_a_render_timer() {
        let now = Instant::now();
        let mut due = BTreeMap::new();
        due.insert("offline".into(), now + Duration::from_secs(30));
        due.insert("live".into(), now + Duration::from_secs(60));
        assert!(take_due(&mut due, now).is_empty());
        assert_eq!(
            take_due(&mut due, now + Duration::from_secs(30)),
            vec!["offline"]
        );
        due.remove("live");
        assert!(take_due(&mut due, now + Duration::from_secs(60)).is_empty());
        let scheduler = Scheduler::default();
        scheduler.schedule("cancelled");
        scheduler.remove("cancelled");
        assert!(scheduler.state.lock().unwrap().due.is_empty());
        scheduler.stop();
        assert!(scheduler.next().is_none());
    }
}
