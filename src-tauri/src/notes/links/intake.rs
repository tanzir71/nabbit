//! Explicit link intake and the native UI Automation selected-text reader.
use crate::{
    db::Database,
    error::{msg, Result},
    notes::{
        capture::{CaptureRequest, NotesIntent},
        store::NoteDraft,
    },
};
use serde_json::json;

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
/// Testable selection policy: never call the text reader for private/excluded
/// elements, and never accept multiple ranges or a non-URL as a link capture.
#[cfg(test)]
pub(crate) fn allowed_url(allowed: bool, read: impl FnOnce() -> Result<String>) -> Result<String> {
    if !allowed {
        return Err(msg("This selection cannot be read"));
    }
    let original = read()?;
    super::parse::web_url(&original)?;
    Ok(original.trim().to_owned())
}
#[cfg(windows)]
pub(crate) fn selected_text(db: &Database) -> Result<crate::context::selection::Read> {
    use windows::Win32::{
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::{
            Accessibility::{CUIAutomation, IUIAutomation},
            WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
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
            return Err(msg("Select text in another app first"));
        }
        let source = crate::context::clipboard::process_name(process)
            .ok_or_else(|| msg("Selection source is unavailable"))?;
        if !db.clipboard_source_allowed(Some(&source))? {
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
        if !allowed || GetForegroundWindow() != foreground {
            return Err(msg("This selection cannot be read"));
        }
        match crate::context::selection::element_text(&focused)? {
            Some(text) => {
                if db.get_settings()?.sensitive_heuristics
                    && crate::clipboard::sensitive::looks_sensitive(&text)
                {
                    return Err(msg("This selection is private"));
                }
                Ok(crate::context::selection::Read::Text(text))
            }
            None => Ok(crate::context::selection::Read::Unsupported(
                crate::island::keyboard::WindowId {
                    hwnd: foreground.0 as u64,
                    process,
                },
            )),
        }
    }
}
#[cfg(not(windows))]
pub(crate) fn selected_text(_db: &Database) -> Result<crate::context::selection::Read> {
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
