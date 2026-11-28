//! Optional selection-copy transaction. All formats are snapshotted before any
//! input is sent, and every attempted copy restores the complete snapshot.
use crate::error::{msg, Result};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
static ACTIVE: AtomicBool = AtomicBool::new(false);
static SUPPRESSED: AtomicU64 = AtomicU64::new(0);
static PENDING: AtomicBool = AtomicBool::new(false);
fn suppress(sequence: u32) {
    SUPPRESSED.store(u64::from(sequence) + 1, Ordering::Release);
}
fn clear_suppression(sequence: u32) {
    let _ = SUPPRESSED.compare_exchange(
        u64::from(sequence) + 1,
        0,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
}
pub fn capture_allowed(sequence: u32) -> bool {
    let value = SUPPRESSED.load(Ordering::Acquire);
    if value == u64::from(sequence) + 1 {
        return false;
    }
    if value != 0 {
        let _ = SUPPRESSED.compare_exchange(value, 0, Ordering::AcqRel, Ordering::Acquire);
    }
    true
}
pub fn recover() -> Result<()> {
    if !PENDING.load(Ordering::Acquire) || crate::context::acceptance() {
        return Ok(());
    }
    #[cfg(windows)]
    {
        crate::shell::run(native::recover_pending)
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}
#[cfg(windows)]
#[path = "fallback_win.rs"]
mod native;
pub fn read(
    enabled: bool,
    db: crate::db::Database,
    target: crate::island::keyboard::WindowId,
) -> Result<String> {
    if !enabled || crate::context::acceptance() {
        return Err(msg(
            "This app does not expose selected text; clipboard fallback is off",
        ));
    }
    #[cfg(windows)]
    {
        crate::shell::run(move || transaction(true, &mut native::Native::new(db, target)))
    }
    #[cfg(not(windows))]
    {
        let _ = (db, target);
        Err(msg("Clipboard selection fallback is available on Windows"))
    }
}
pub fn active() -> bool {
    ACTIVE.load(Ordering::Acquire)
}
pub trait Port {
    type Snapshot;
    fn eligible(&mut self) -> bool;
    fn snapshot(&mut self) -> Result<Self::Snapshot>;
    fn copy_selection(&mut self) -> Result<()>;
    fn read_text(&mut self) -> Result<String>;
    fn restore(&mut self, snapshot: Self::Snapshot) -> Result<()>;
}
pub fn transaction<P: Port>(enabled: bool, port: &mut P) -> Result<String> {
    if !enabled || !port.eligible() {
        return Err(msg("Selection clipboard fallback is unavailable"));
    }
    if ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(msg("Another selection read is in progress"));
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            ACTIVE.store(false, Ordering::Release);
        }
    }
    let _guard = Guard;
    let snapshot = port.snapshot()?;
    if !port.eligible() {
        return Err(msg("The selected app changed before copying"));
    }
    let result = (|| {
        port.copy_selection()?;
        if !port.eligible() {
            return Err(msg("The selected app changed while copying"));
        }
        super::selection::allowed_text(true, || port.read_text())
    })();
    port.restore(snapshot)
        .map_err(|_| msg("The clipboard could not be fully restored"))?;
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    type Formats = std::collections::BTreeMap<String, Vec<u8>>;
    struct Fake {
        formats: Formats,
        original: Formats,
        allowed: bool,
        copy_error: bool,
        read_error: bool,
        preflight_error: bool,
        copies: usize,
        restores: usize,
    }
    impl Port for Fake {
        type Snapshot = Formats;
        fn eligible(&mut self) -> bool {
            self.allowed
        }
        fn snapshot(&mut self) -> Result<Formats> {
            if self.preflight_error {
                Err(msg("cannot preserve a format"))
            } else {
                Ok(self.formats.clone())
            }
        }
        fn copy_selection(&mut self) -> Result<()> {
            self.copies += 1;
            self.formats.clear();
            self.formats
                .insert("CF_UNICODETEXT".into(), b"selected text".to_vec());
            if self.copy_error {
                Err(msg("copy failed after changing clipboard"))
            } else {
                Ok(())
            }
        }
        fn read_text(&mut self) -> Result<String> {
            if self.read_error {
                Err(msg("read failed"))
            } else {
                Ok("Selected বাংলা".into())
            }
        }
        fn restore(&mut self, snapshot: Formats) -> Result<()> {
            self.restores += 1;
            self.formats = snapshot;
            Ok(())
        }
    }
    fn fake() -> Fake {
        let original = [
            ("CF_UNICODETEXT", vec![0, 1, 2, 0]),
            ("HTML Format", b"<b>original</b>".to_vec()),
            ("Rich Text Format", br"{\rtf1 original}".to_vec()),
            ("PNG", vec![137, 80, 78, 71, 0, 1]),
            ("CF_DIBV5", vec![124, 0, 0, 0, 255]),
            ("CF_HDROP", vec![20, 0, 0, 0, 1, 0, 0]),
            ("Custom application format", vec![0, 255, 17, 0]),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v))
        .collect::<Formats>();
        Fake {
            formats: original.clone(),
            original,
            allowed: true,
            copy_error: false,
            read_error: false,
            preflight_error: false,
            copies: 0,
            restores: 0,
        }
    }
    #[test]
    fn fallback_restores_every_opaque_format_on_success_send_failure_and_read_failure() {
        for (copy_error, read_error) in [(false, false), (true, false), (false, true)] {
            let mut port = fake();
            port.copy_error = copy_error;
            port.read_error = read_error;
            let result = transaction(true, &mut port);
            assert_eq!(result.is_ok(), !copy_error && !read_error);
            assert_eq!(port.formats, port.original);
            assert_eq!((port.copies, port.restores), (1, 1));
            assert!(!active());
        }
    }
    #[test]
    fn opt_out_private_targets_and_unpreservable_formats_never_send_copy() {
        let mut port = fake();
        assert!(transaction(false, &mut port).is_err());
        assert_eq!(port.copies, 0);
        port.allowed = false;
        assert!(transaction(true, &mut port).is_err());
        assert_eq!(port.copies, 0);
        port.allowed = true;
        port.preflight_error = true;
        assert!(transaction(true, &mut port).is_err());
        assert_eq!((port.copies, port.restores), (0, 0));
        assert_eq!(port.formats, port.original);
        assert!(!active());
    }
    #[test]
    fn a_failed_restore_sequence_is_not_captured_and_a_newer_copy_releases_the_suppression() {
        suppress(27);
        assert!(!capture_allowed(27));
        assert!(capture_allowed(28));
        assert!(capture_allowed(27));
        suppress(u32::MAX);
        assert!(!capture_allowed(u32::MAX));
        clear_suppression(u32::MAX);
        assert!(capture_allowed(u32::MAX));
    }
}
