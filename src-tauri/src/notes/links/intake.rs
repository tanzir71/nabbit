//! URL-only foundation for explicit note/selection hotkeys. No synthetic keys,
//! clipboard fallback or background selection collection. General text tools
//! will use the same native reader in their own phase.
use crate::{
    db::Database,
    error::{msg, Result},
    notes::{
        capture::{CaptureRequest, NotesIntent},
        store::NoteDraft,
    },
};
use serde_json::json;
use tauri::{Emitter, Manager};

pub fn url_intent(db: &Database, input: &str) -> Result<NotesIntent> {
    super::parse::web_url(input)?;
    let url = input.trim().to_owned();
    Ok(NotesIntent::New {
        request: Box::new(CaptureRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            expected_scope: db.notes_context()?,
            draft: NoteDraft {
                title: url.clone(),
                url,
                kind: Some("bookmark".into()),
                priority: Some("inbox".into()),
                ..Default::default()
            },
            patch: json!({}),
            reminders: vec![],
        }),
    })
}
pub fn selection_hotkey(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = &app.state::<crate::AppState>().db;
        match selected_url(db).and_then(|url| url_intent(db, &url)) {
            Ok(intent) => {
                let _ = crate::notes::capture::open(&app, intent);
            }
            Err(_) => {
                let _=app.emit("capture:error","Select an http or https link in a text field, then try the selected-link shortcut again.");
            }
        }
    });
}
/// Testable selection policy: never call the text reader for private/excluded
/// elements, and never accept multiple ranges or a non-URL as a link capture.
pub(crate) fn allowed_url(allowed: bool, read: impl FnOnce() -> Result<String>) -> Result<String> {
    if !allowed {
        return Err(msg("This selection cannot be read"));
    }
    let original = read()?;
    super::parse::web_url(&original)?;
    Ok(original.trim().to_owned())
}
#[cfg(windows)]
fn selected_url(db: &Database) -> Result<String> {
    use windows::{
        core::Interface,
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED,
            },
            UI::{
                Accessibility::{
                    CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId,
                },
                WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
            },
        },
    };
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|_| msg("Selection reading is unavailable"))?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        let foreground = GetForegroundWindow();
        let mut process = 0;
        GetWindowThreadProcessId(foreground, Some(&mut process));
        if process == 0 || process == std::process::id() {
            return Err(msg("Select a link in another app first"));
        }
        let system = sysinfo::System::new_all();
        let source = system
            .process(sysinfo::Pid::from_u32(process))
            .map(|p| p.name().to_string_lossy().into_owned());
        if source
            .as_deref()
            .is_some_and(|s| db.is_excluded_app(s).unwrap_or(true))
        {
            return Err(msg("This app is excluded from context capture"));
        }
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| msg("Selection reading is unavailable"))?;
        let focused = automation
            .GetFocusedElement()
            .map_err(|_| msg("No readable selection"))?;
        let allowed = !focused
            .CurrentIsPassword()
            .map_err(|_| msg("Selection privacy status is unavailable"))?
            .as_bool()
            && focused
                .CurrentProcessId()
                .map_err(|_| msg("No readable selection"))? as u32
                == process;
        allowed_url(allowed, || {
            if GetForegroundWindow() != foreground {
                return Err(msg("The focused app changed"));
            }
            let pattern = focused
                .GetCurrentPattern(UIA_TextPatternId)
                .and_then(|p| p.cast::<IUIAutomationTextPattern>())
                .map_err(|_| msg("This app does not expose selected text"))?;
            let ranges = pattern
                .GetSelection()
                .map_err(|_| msg("No readable selection"))?;
            if ranges.Length().map_err(|_| msg("No readable selection"))? != 1 {
                return Err(msg("Select one web link"));
            }
            let text = ranges
                .GetElement(0)
                .and_then(|r| r.GetText(16_385))
                .map_err(|_| msg("No readable selection"))?
                .to_string();
            if db.get_settings()?.sensitive_heuristics
                && crate::clipboard::sensitive::looks_sensitive(&text)
            {
                return Err(msg("This selection is private"));
            }
            Ok(text)
        })
    }
}
#[cfg(not(windows))]
fn selected_url(_db: &Database) -> Result<String> {
    Err(msg("Native selection reading is available on Windows"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_policy_never_reads_private_elements_and_only_accepts_web_links() {
        assert!(allowed_url(false, || panic!("private/excluded selection read")).is_err());
        assert!(allowed_url(true, || Ok("ordinary selected text".into())).is_err());
        assert!(allowed_url(true, || Ok("javascript:alert(1)".into())).is_err());
        assert_eq!(
            allowed_url(true, || Ok("HTTPS://EXAMPLE.COM/docs".into())).unwrap(),
            "HTTPS://EXAMPLE.COM/docs"
        );
    }
    #[test]
    fn url_intent_is_unsaved_and_keeps_the_original_scope_epoch() {
        let db = Database::open(
            &std::env::temp_dir().join(format!("nabbit-link-intake-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let NotesIntent::New { request } =
            url_intent(&db, "HTTPS://EXAMPLE.INVALID/docs?utm_source=keep#part").unwrap()
        else {
            panic!("Expected an unsaved bookmark");
        };
        assert_eq!(request.draft.kind.as_deref(), Some("bookmark"));
        assert_eq!(
            request.draft.url,
            "HTTPS://EXAMPLE.INVALID/docs?utm_source=keep#part"
        );
        assert!(request.expected_scope.is_none());
        assert!(db.list_note_cards().unwrap().is_empty());
        db.tack_activate(&crate::notes::sync_store::Identity {
            base_url: "https://fixture.invalid/".into(),
            user_id: "u".into(),
            workspace_id: "personal".into(),
        })
        .unwrap();
        assert!(db.capture_note_enriched(*request, None, true).is_err());
    }
}
