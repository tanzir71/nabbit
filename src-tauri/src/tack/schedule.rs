//! Pure monotonic-deadline policy; the runtime blocks on a condition variable.
use super::model::{Error, ErrorCode};
#[derive(Default, Debug)]
pub(crate) struct Schedule {
    pub active: bool,
    pub running: bool,
    pub stopped: bool,
    pub next: Option<u64>,
    pub windows_open: bool,
    not_before: u64,
    rate_limited: bool,
    failures: u32,
    periodic: bool,
}
impl Schedule {
    pub fn connect(&mut self, now: u64) {
        self.active = true;
        self.not_before = 0;
        self.rate_limited = false;
        self.failures = 0;
        self.next = Some(now);
        self.periodic = false;
    }
    pub fn disconnect(&mut self) {
        self.active = false;
        self.next = None;
        self.not_before = 0;
        self.rate_limited = false;
        self.failures = 0;
        self.periodic = false;
    }
    pub fn edit(&mut self, now: u64) {
        if self.active {
            self.next = Some(now.saturating_add(1500).max(self.not_before));
            self.periodic = false;
        }
    }
    pub fn request(&mut self, now: u64) {
        if self.active {
            self.next = Some(now.max(self.not_before));
            self.periodic = false;
        }
    }
    pub fn visibility(&mut self, now: u64, open: bool) {
        if self.windows_open != open {
            self.windows_open = open;
            // Visibility adjusts heartbeats, never an edit, explicit request or
            // retry deadline. Hiding a window must not postpone a pending save.
            if self.active && !self.running && self.periodic {
                self.next = Some(
                    now.saturating_add(if open { 60_000 } else { 300_000 })
                        .max(self.not_before),
                );
            }
        }
    }
    pub fn network_regained(&mut self, now: u64) {
        if !self.rate_limited {
            self.not_before = 0;
        }
        self.request(now);
    }
    pub fn due(&mut self, now: u64) -> bool {
        if !self.stopped && self.active && !self.running && self.next.is_some_and(|n| n <= now) {
            self.next = None;
            self.periodic = false;
            self.running = true;
            true
        } else {
            false
        }
    }
    pub fn success(&mut self, now: u64, pending: bool) {
        self.running = false;
        self.not_before = 0;
        self.rate_limited = false;
        self.failures = 0;
        if self.active {
            let next = now.saturating_add(if pending {
                1500
            } else if self.windows_open {
                60_000
            } else {
                300_000
            });
            if self.next.is_none_or(|n| n > next) {
                self.next = Some(next);
                self.periodic = !pending;
            }
        }
    }
    pub fn failed(&mut self, now: u64, error: &Error) {
        self.running = false;
        self.periodic = false;
        match error.code {
            ErrorCode::Offline
            | ErrorCode::InvalidResponse
            | ErrorCode::LocalStorage
            | ErrorCode::RateLimited => {
                self.failures = self.failures.saturating_add(1);
                self.rate_limited = error.code == ErrorCode::RateLimited;
                let delay = if self.rate_limited {
                    error.retry_after_ms.unwrap_or(60_000)
                } else {
                    1000u64
                        .saturating_mul(1u64 << self.failures.min(9))
                        .min(300_000)
                };
                self.not_before = now.saturating_add(delay);
                self.next = Some(self.not_before);
            }
            ErrorCode::SignedOut | ErrorCode::WorkspaceChanged | ErrorCode::SecureStorage => {
                self.disconnect()
            }
            _ => {
                self.next = None;
                self.not_before = 0;
            }
        }
    }
    pub fn wait(&self, now: u64) -> Option<u64> {
        if self.active && !self.running {
            self.next.map(|n| n.saturating_sub(now))
        } else {
            None
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debounce_focus_visibility_and_periodic_intervals() {
        let mut s = Schedule::default();
        s.edit(0);
        assert_eq!(s.wait(0), None);
        s.connect(10);
        assert!(s.due(10));
        s.success(20, false);
        assert_eq!(s.next, Some(300020));
        s.visibility(30, true);
        assert_eq!(s.next, Some(60030));
        s.edit(40);
        s.edit(1000);
        assert!(!s.due(2499));
        assert!(s.due(2500));
        s.edit(2600);
        s.success(2700, true);
        assert_eq!(s.next, Some(4100));
        s.request(3000);
        assert!(s.due(3000));
        s.success(3001, false);
        assert_eq!(s.next, Some(63001));
        s.visibility(4000, false);
        assert_eq!(s.next, Some(304000));
        s.disconnect();
        assert_eq!(s.wait(999999), None);
    }
    #[test]
    fn backoff_caps_and_network_regain_cannot_bypass_retry_after() {
        let mut s = Schedule::default();
        s.connect(0);
        let offline = Error::new(ErrorCode::Offline);
        for i in 0..12 {
            s.failed(i, &offline);
            assert!(s.next.unwrap() - i <= 300000);
        }
        s.request(20);
        assert!(!s.due(20));
        s.network_regained(30);
        assert!(s.due(30));
        let mut limited = Error::new(ErrorCode::RateLimited);
        limited.retry_after_ms = Some(900000);
        s.failed(40, &limited);
        s.edit(50);
        s.request(60);
        s.network_regained(70);
        assert!(!s.due(900039));
        assert!(s.due(900040));
        s.success(900041, false);
        assert_eq!(s.next, Some(1200041));
    }
    #[test]
    fn hiding_or_showing_windows_preserves_pending_edits_requests_and_retries() {
        let mut s = Schedule::default();
        s.connect(0);
        assert!(s.due(0));
        s.success(1, false);
        s.visibility(2, true);
        assert_eq!(s.next, Some(60002));
        s.edit(10);
        s.visibility(20, false);
        assert_eq!(s.next, Some(1510));
        s.visibility(30, true);
        assert!(s.due(1510));
        s.success(1511, false);
        s.request(1600);
        s.visibility(1610, false);
        assert!(s.due(1610));
        s.failed(1611, &Error::new(ErrorCode::Offline));
        let retry = s.next;
        s.visibility(1700, true);
        assert_eq!(s.next, retry);
        s.failed(1800, &Error::new(ErrorCode::StorageFull));
        s.visibility(1900, false);
        assert_eq!(s.next, None);
    }
    #[test]
    fn nonretryable_errors_wait_for_an_explicit_signal() {
        let mut s = Schedule::default();
        s.connect(0);
        s.failed(0, &Error::new(ErrorCode::StorageFull));
        assert_eq!(s.wait(0), None);
        s.request(100);
        assert!(s.due(100));
        s.failed(101, &Error::new(ErrorCode::SignedOut));
        assert_eq!(s.wait(u64::MAX), None);
        s.network_regained(999);
        assert_eq!(s.wait(999), None);
    }
}
