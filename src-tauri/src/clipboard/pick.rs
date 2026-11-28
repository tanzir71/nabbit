//! Clipboard picking reuses the v0.1 history. OS writes/focus/input are explicit
//! ports so tests never read/write the real clipboard or synthesize global keys.
use crate::{
    db::Database,
    error::{msg, Result},
    island::keyboard::WindowId,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Copy,
    Paste,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub window: WindowId,
    pub target: WindowId,
    pub request_id: u64,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Copied,
    PasteSent,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Outcome {
    pub kind: Kind,
    pub message: String,
}
fn copied(message: &str) -> Outcome {
    Outcome {
        kind: Kind::Copied,
        message: message.into(),
    }
}
pub trait Port {
    fn eligible(&self, ticket: Ticket) -> bool;
    fn copy_text(&mut self, text: &str) -> Result<()>;
    fn copy_image(&mut self, _path: &std::path::Path) -> Result<()> {
        Err(msg("Image copying is unavailable"))
    }
    fn copy_files(&mut self, _paths: &[String]) -> Result<()> {
        Err(msg("File copying is unavailable"))
    }
    fn restore(&mut self, ticket: Ticket) -> bool;
    fn paste(&mut self, ticket: Ticket) -> bool;
    fn collapse(&mut self);
}
pub fn pick(
    db: &Database,
    id: &str,
    mode: Mode,
    ticket: Option<Ticket>,
    port: &mut dyn Port,
) -> Result<Outcome> {
    let entry = db.get_clipboard_entry(id)?;
    if !matches!(
        entry.content_type.as_str(),
        "text" | "url" | "file" | "image"
    ) {
        return Err(msg(
            "This clipboard item has no supported text or path payload",
        ));
    }
    if mode == Mode::Paste && ticket.is_some_and(|t| !port.eligible(t)) {
        return Err(msg("Focus changed before this clipboard pick"));
    }
    if entry.content_type == "image" {
        port.copy_image(&db.clipboard_image_path(id)?)?;
    } else if entry.content_type == "file" && entry.content.starts_with('[') {
        port.copy_files(&serde_json::from_str::<Vec<String>>(&entry.content)?)?;
    } else {
        port.copy_text(&entry.content)?;
    }
    if db.touch_clipboard_entry(id).is_err() {
        return Ok(copied("Copied. Clipboard history could not be updated."));
    }
    if mode == Mode::Copy {
        return Ok(copied("Copied"));
    }
    let Some(ticket) = ticket else {
        return Ok(copied("Copied. Return to your app and press Ctrl+V."));
    };
    if !port.eligible(ticket) || !port.restore(ticket) || !port.paste(ticket) {
        return Ok(copied(
            "Copied. Automatic paste was unavailable; use Ctrl+V in your app.",
        ));
    }
    port.collapse();
    Ok(Outcome {
        kind: Kind::PasteSent,
        message: "Paste sent".into(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        calls: Vec<String>,
        eligible: bool,
        restore: bool,
        send: bool,
        fail_copy: bool,
        change_during_copy: bool,
    }
    impl Port for Fake {
        fn copy_image(&mut self, path: &std::path::Path) -> Result<()> {
            assert!(path.is_file());
            self.calls.push("copy:image".into());
            Ok(())
        }
        fn copy_files(&mut self, paths: &[String]) -> Result<()> {
            self.calls.push(format!("copy:files:{}", paths.len()));
            Ok(())
        }
        fn eligible(&self, _: Ticket) -> bool {
            self.eligible
        }
        fn copy_text(&mut self, text: &str) -> Result<()> {
            self.calls.push(format!("copy:{text}"));
            if self.fail_copy {
                return Err(msg("fixture clipboard unavailable"));
            }
            if self.change_during_copy {
                self.eligible = false;
            }
            Ok(())
        }
        fn restore(&mut self, _: Ticket) -> bool {
            self.calls.push("restore".into());
            self.restore
        }
        fn paste(&mut self, _: Ticket) -> bool {
            self.calls.push("paste".into());
            self.send
        }
        fn collapse(&mut self) {
            self.calls.push("collapse".into());
        }
    }
    fn setup() -> (Database, String, Ticket, Fake) {
        let db = Database::open(
            &std::env::temp_dir().join(format!("nabbit-pick-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let e = db
            .add_clipboard_text("Fixture clipboard text বাংলা", Some("Fixture".into()))
            .unwrap()
            .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE clipboard_entries SET last_used_at='2024-01-01T00:00:00Z' WHERE id=?1",
                [&e.id],
            )
            .unwrap();
        let t = Ticket {
            window: WindowId {
                hwnd: 1,
                process: 1,
            },
            target: WindowId {
                hwnd: 2,
                process: 2,
            },
            request_id: 7,
        };
        (
            db,
            e.id,
            t,
            Fake {
                eligible: true,
                restore: true,
                send: true,
                ..Default::default()
            },
        )
    }
    #[test]
    fn image_and_explorer_payloads_use_their_native_ports_without_global_clipboard_access() {
        let (db, _, _, mut port) = setup();
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::RgbImage::new(8, 5)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let image = db
            .add_clipboard_image(bytes.get_ref(), None)
            .unwrap()
            .unwrap();
        pick(&db, &image.id, Mode::Copy, None, &mut port).unwrap();
        assert_eq!(port.calls, ["copy:image"]);
        let files = db
            .add_clipboard_files(
                vec![std::env::temp_dir()
                    .join("never-opened.txt")
                    .to_string_lossy()
                    .into()],
                None,
            )
            .unwrap()
            .unwrap();
        port.calls.clear();
        pick(&db, &files.id, Mode::Copy, None, &mut port).unwrap();
        assert_eq!(port.calls, ["copy:files:1"]);
        assert!(db
            .get_clipboard_entry(&image.id)
            .unwrap()
            .content
            .starts_with("data:image/png;base64,"));
    }
    #[test]
    fn explicit_paste_writes_touches_restores_sends_once_then_collapses() {
        let (db, id, t, mut p) = setup();
        assert_eq!(
            pick(&db, &id, Mode::Paste, Some(t), &mut p).unwrap().kind,
            Kind::PasteSent
        );
        assert_eq!(
            p.calls,
            [
                "copy:Fixture clipboard text বাংলা",
                "restore",
                "paste",
                "collapse"
            ]
        );
        assert!(db.get_clipboard_entry(&id).unwrap().last_used_at.year() > 2024);
    }
    use chrono::Datelike;
    #[test]
    fn copy_and_missing_focus_lease_never_activate_or_send_input() {
        for mode in [Mode::Copy, Mode::Paste] {
            let (db, id, _, mut p) = setup();
            assert_eq!(
                pick(&db, &id, mode, None, &mut p).unwrap().kind,
                Kind::Copied
            );
            assert_eq!(p.calls.len(), 1);
        }
    }
    #[test]
    fn invalid_item_or_stale_target_never_changes_clipboard() {
        let (db, id, t, mut p) = setup();
        assert!(pick(&db, "missing", Mode::Paste, Some(t), &mut p).is_err());
        assert!(p.calls.is_empty());
        p.eligible = false;
        assert!(pick(&db, &id, Mode::Paste, Some(t), &mut p).is_err());
        assert!(p.calls.is_empty());
        db.conn.lock().unwrap().execute("UPDATE clipboard_entries SET content_type='image',blob_path='C:/must-not-read/private.png' WHERE id=?1",[&id]).unwrap();
        assert!(pick(&db, &id, Mode::Copy, None, &mut p).is_err());
        assert!(p.calls.is_empty());
    }
    #[test]
    fn copy_failure_never_touches_history_or_sends_input() {
        let (db, id, t, mut p) = setup();
        p.fail_copy = true;
        assert!(pick(&db, &id, Mode::Paste, Some(t), &mut p).is_err());
        assert_eq!(
            db.get_clipboard_entry(&id).unwrap().last_used_at.year(),
            2024
        );
        assert_eq!(p.calls.len(), 1);
    }
    #[test]
    fn focus_changes_denial_and_blocked_input_fall_back_to_copy_without_collapse() {
        for step in 0..3 {
            let (db, id, t, mut p) = setup();
            match step {
                0 => p.change_during_copy = true,
                1 => p.restore = false,
                _ => p.send = false,
            }
            assert_eq!(
                pick(&db, &id, Mode::Paste, Some(t), &mut p).unwrap().kind,
                Kind::Copied
            );
            assert!(!p.calls.iter().any(|s| s == "collapse"));
            if step == 0 {
                assert_eq!(p.calls.len(), 1);
            }
            if step == 1 {
                assert!(!p.calls.iter().any(|s| s == "paste"));
            }
        }
    }
}
