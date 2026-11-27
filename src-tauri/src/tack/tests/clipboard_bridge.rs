//! Test-only SQLite/pick bridge. The Port records intent; no OS clipboard,
//! foreground activation, file reads or synthesized global input is possible.
use crate::{
    clipboard::pick::{self, Mode, Port, Ticket},
    db::Database,
    error::{msg, Result},
    island::keyboard::WindowId,
};
use serde_json::{json, Map, Value};
use std::sync::{mpsc, Mutex};
#[derive(Default)]
pub(super) struct Fixture {
    calls: Vec<String>,
    mode: String,
}
impl Port for Fixture {
    fn eligible(&self, _: Ticket) -> bool {
        self.mode != "stale"
    }
    fn copy_text(&mut self, text: &str) -> Result<()> {
        if self.mode == "copy-error" {
            return Err(msg("Fixture write failed"));
        }
        self.calls.push(format!("copy:{text}"));
        Ok(())
    }
    fn restore(&mut self, _: Ticket) -> bool {
        self.calls.push("restore".into());
        self.mode != "denied"
    }
    fn paste(&mut self, _: Ticket) -> bool {
        self.calls.push("paste".into());
        self.mode != "blocked"
    }
    fn collapse(&mut self) {
        self.calls.push("collapse".into());
    }
}
pub(super) fn handles(command: &str) -> bool {
    [
        "list_clipboard_entries",
        "get_storage_stats",
        "island_clipboard_pick",
        "toggle_pin_clipboard_entry",
        "delete_clipboard_entry",
        "test.clipboard",
    ]
    .contains(&command)
}
pub(super) fn route(
    db: &Database,
    fixture: &Mutex<Fixture>,
    command: &str,
    args: Map<String, Value>,
    events: &Mutex<Vec<mpsc::Sender<String>>>,
) -> crate::tack::model::Result<Value> {
    let result: Result<Value> = (|| {
        let id = args.get("id").and_then(Value::as_str).unwrap_or("");
        let value = match command {
            "test.clipboard" => {
                let mut fixture = fixture.lock().unwrap();
                if let Some(mode) = args.get("mode").and_then(Value::as_str) {
                    fixture.mode = mode.into();
                }
                if args.get("seed").and_then(Value::as_bool) == Some(true) {
                    for (i, text) in [
                        "Meeting moved to 4:30",
                        "https://example.invalid/research?utm_source=keep#section",
                        r"C:\Fixture\README.md",
                        "Screenshot 1280 × 720",
                        "Plan for 2027",
                    ]
                    .iter()
                    .enumerate()
                    {
                        let entry = db
                            .add_clipboard_text(text, Some("Fixture".into()))?
                            .unwrap();
                        db.conn.lock().unwrap().execute("UPDATE clipboard_entries SET content_type=?1,last_used_at=?2,pinned=?3 WHERE id=?4", rusqlite::params![["text","url","file","image","text"][i],format!("2026-11-27T04:00:0{}Z",9-i),i==0,entry.id])?;
                    }
                }
                return Ok(json!({"calls":fixture.calls,"rows":db.list_clipboard_entries(None)?}));
            }
            "list_clipboard_entries" => {
                return Ok(serde_json::to_value(db.list_clipboard_entries(None)?)?)
            }
            "get_storage_stats" => return Ok(serde_json::to_value(db.stats()?)?),
            "toggle_pin_clipboard_entry" => {
                serde_json::to_value(db.toggle_pin_clipboard_entry(id)?)?
            }
            "delete_clipboard_entry" => {
                db.delete_clipboard_entry(id)?;
                Value::Null
            }
            "island_clipboard_pick" => {
                let mode: Mode =
                    serde_json::from_value(args.get("mode").cloned().unwrap_or(Value::Null))?;
                let mut fixture = fixture.lock().unwrap();
                let ticket = (fixture.mode != "no-lease").then_some(Ticket {
                    window: WindowId {
                        hwnd: 11,
                        process: 11,
                    },
                    target: WindowId {
                        hwnd: 22,
                        process: 22,
                    },
                    request_id: 1,
                });
                serde_json::to_value(pick::pick(db, id, mode, ticket, &mut *fixture)?)?
            }
            _ => return Err(msg("Unknown clipboard bridge command")),
        };
        let packet = format!(
            "data: {}\n\n",
            json!({"event":"clipboard:changed","payload":null})
        );
        events
            .lock()
            .unwrap()
            .retain(|sender| sender.send(packet.clone()).is_ok());
        Ok(value)
    })();
    result.map_err(|_| crate::tack::model::Error::new(crate::tack::model::ErrorCode::InvalidInput))
}
