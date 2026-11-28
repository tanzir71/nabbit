use crate::{
    db::models::ClipboardEntry,
    error::{msg, Result},
};
use tauri::{Emitter, Manager};
pub enum Read {
    Text(String),
    Unsupported(crate::island::keyboard::WindowId),
}
#[cfg(windows)]
pub(crate) fn element_text(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Result<Option<String>> {
    use windows::{
        core::Interface,
        Win32::UI::Accessibility::{IUIAutomationTextPattern, UIA_TextPatternId},
    };
    unsafe {
        if element
            .CurrentIsPassword()
            .map_err(|_| msg("Selection privacy status is unavailable"))?
            .as_bool()
        {
            return Err(msg("This selection is private"));
        }
        let pattern = match element
            .GetCurrentPattern(UIA_TextPatternId)
            .and_then(|p| p.cast::<IUIAutomationTextPattern>())
        {
            Ok(pattern) => pattern,
            Err(_) => return Ok(None),
        };
        let ranges = pattern
            .GetSelection()
            .map_err(|_| msg("No readable selection"))?;
        if ranges.Length().map_err(|_| msg("No readable selection"))? != 1 {
            return Err(msg("Select one text range"));
        }
        let text = ranges
            .GetElement(0)
            .and_then(|r| r.GetText(32770))
            .map_err(|_| msg("No readable selection"))?;
        let text = String::from_utf16(&text)
            .map_err(|_| msg("The selection contains invalid or truncated text"))?;
        allowed_text(true, || Ok(text)).map(Some)
    }
}
fn selected(db: &crate::db::Database) -> Result<String> {
    let text = match crate::notes::links::intake::selected_text(db)? {
        Read::Text(text) => text,
        Read::Unsupported(target) => super::fallback::read(
            super::registration::preferences(db)?.selection_copy_fallback,
            db.clone(),
            target,
        )?,
    };
    if db.get_settings()?.sensitive_heuristics
        && crate::clipboard::sensitive::looks_sensitive(&text)
    {
        return Err(msg("This selection is private"));
    }
    Ok(text)
}
pub(crate) fn allowed_text(allowed: bool, read: impl FnOnce() -> Result<String>) -> Result<String> {
    if !allowed {
        return Err(msg("This selection cannot be read"));
    }
    let text = read()?;
    if text.trim().is_empty() || text.chars().count() > 16384 || text.contains('\0') {
        return Err(msg("Select between 1 and 16384 characters"));
    }
    Ok(text)
}
pub(crate) fn draft(text: String) -> ClipboardEntry {
    let now = chrono::Utc::now();
    ClipboardEntry {
        id: uuid::Uuid::new_v4().to_string(),
        content_type: crate::util::content_type_for_text(&text),
        preview: crate::util::preview_text(&text),
        hash: crate::util::sha256_hex(text.as_bytes()),
        content: text,
        source_app: Some("Selected text".into()),
        pinned: false,
        created_at: now,
        last_used_at: now,
        blob_path: None,
    }
}
pub fn hotkey(app: &tauri::AppHandle) {
    if super::silent(app) || crate::context::acceptance() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = &app.state::<crate::AppState>().db;
        match selected(db) {
            Ok(text) => {
                if let Err(error) = open(&app, text) {
                    let _ = app.emit("capture:error", error.to_string());
                }
            }
            Err(_) => {
                let _ = app.emit(
                    "capture:error",
                    "Select text in an accessible, non-private field, then try Ctrl+Alt+S again.",
                );
            }
        }
    });
}
pub(crate) fn open(app: &tauri::AppHandle, text: String) -> Result<()> {
    if super::silent(app) {
        return Ok(());
    }
    let text = allowed_text(true, || Ok(text))?;
    *app.state::<super::Service>()
        .selection
        .lock()
        .map_err(|_| msg("Selection is unavailable"))? = Some(draft(text));
    #[cfg(windows)]
    if let Some(manager) = app.try_state::<std::sync::Arc<crate::island::Manager>>() {
        if manager
            .open_context_capture(crate::island::keyboard::Target::Clipboard)
            .map_err(msg)?
        {
            app.emit("context:changed", ())?;
            return Ok(());
        }
    }
    let state = app.state::<crate::AppState>();
    crate::commands::settings::patch(app, &state, serde_json::json!({"lastTab":"clipboard"}))?;
    crate::show_popover(app)?;
    app.emit("shortcut:clipboard-search", ())?;
    app.emit("context:changed", ())?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_text_policy_never_reads_password_or_excluded_fields_and_keeps_whitespace() {
        assert!(allowed_text(false, || panic!("private selection read")).is_err());
        assert_eq!(
            allowed_text(true, || Ok("  Selected বাংলা\n".into())).unwrap(),
            "  Selected বাংলা\n"
        );
        assert!(allowed_text(true, || Ok(" ".into())).is_err());
        assert!(allowed_text(true, || Ok("x".repeat(16385))).is_err());
        let entry = draft("https://example.invalid/".into());
        assert_eq!(entry.content_type, "url");
        assert!(entry.blob_path.is_none());
    }
}
