//! OLE targets for Nabbit's own WebView descendants. Never attach to Explorer.
use crate::error::{msg, Result};
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
};
use tauri::{Emitter, Manager};
use windows::{
    core::*,
    Win32::{
        Foundation::{HWND, LPARAM, POINT, POINTL},
        Graphics::Gdi::ScreenToClient,
        System::{Com::*, Memory::*, Ole::*, SystemServices::MODIFIERKEYS_FLAGS},
        UI::{Shell::*, WindowsAndMessaging::*},
    },
};
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub files: Vec<String>,
    pub text: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub kind: String,
    pub payload: Payload,
    pub x: i32,
    pub y: i32,
    pub shift: bool,
    pub ctrl: bool,
}
pub(super) fn payload(object: &IDataObject) -> Result<Payload> {
    unsafe {
        if let Ok(items) = SHCreateShellItemArrayFromDataObject::<_, IShellItemArray>(object) {
            let mut files = Vec::new();
            for index in 0..items.GetCount().map_err(|e| msg(e.to_string()))?.min(257) {
                let item = items.GetItemAt(index).map_err(|e| msg(e.to_string()))?;
                if let Ok(name) = item.GetDisplayName(SIGDN_FILESYSPATH) {
                    let value = name.to_string();
                    CoTaskMemFree(Some(name.0.cast()));
                    files.push(value.map_err(|e| msg(e.to_string()))?);
                }
            }
            if !files.is_empty() {
                return Ok(Payload { files, text: None });
            }
        }
        let format = FORMATETC {
            cfFormat: 13,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
            ..Default::default()
        };
        let mut medium = object
            .GetData(&format)
            .map_err(|_| msg("This drag does not contain disk files or text"))?;
        let result = (|| -> Result<Payload> {
            let handle = medium.u.hGlobal;
            let bytes = GlobalSize(handle);
            if bytes == 0 || bytes > 2_000_000 {
                return Err(msg("This dropped text is too large"));
            }
            let data = GlobalLock(handle);
            if data.is_null() {
                return Err(msg("Dropped text is unavailable"));
            }
            let chars = std::slice::from_raw_parts(data.cast::<u16>(), bytes / 2);
            let end = chars.iter().position(|c| *c == 0).unwrap_or(chars.len());
            let text = String::from_utf16_lossy(&chars[..end]);
            let _ = GlobalUnlock(handle);
            Ok(Payload {
                files: Vec::new(),
                text: Some(text),
            })
        })();
        ReleaseStgMedium(&mut medium);
        result
    }
}
struct Lease {
    active: AtomicBool,
    targets: AtomicUsize,
}
static LEASES: OnceLock<Mutex<HashMap<String, Arc<Lease>>>> = OnceLock::new();
type Listener = dyn Fn(Event) + Send + Sync;
#[implement(IDropTarget)]
struct Target {
    root: isize,
    lease: Arc<Lease>,
    listener: Weak<Listener>,
    data: Mutex<Option<Payload>>,
}
impl Target_Impl {
    fn send(&self, kind: &str, point: &POINTL, keys: MODIFIERKEYS_FLAGS, data: Payload) {
        if !self.lease.active.load(Ordering::Acquire) {
            return;
        }
        if let Some(listener) = self.listener.upgrade() {
            let mut point = POINT {
                x: point.x,
                y: point.y,
            };
            unsafe {
                let _ = ScreenToClient(HWND(self.root as _), &mut point);
            }
            listener(Event {
                kind: kind.into(),
                payload: data,
                x: point.x,
                y: point.y,
                shift: keys.0 & 4 != 0,
                ctrl: keys.0 & 8 != 0,
            });
        }
    }
}
#[allow(non_snake_case)]
impl IDropTarget_Impl for Target_Impl {
    fn DragEnter(
        &self,
        object: Ref<IDataObject>,
        keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if !self.lease.active.load(Ordering::Acquire) {
            unsafe {
                *effect = DROPEFFECT_NONE;
            }
            return Ok(());
        }
        let data = object.as_ref().and_then(|object| payload(object).ok());
        unsafe {
            *effect = if data.is_some() {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
        }
        if let Some(data) = &data {
            self.send("enter", point, keys, data.clone());
        }
        if let Ok(mut previous) = self.data.lock() {
            *previous = data;
        }
        Ok(())
    }
    fn DragOver(
        &self,
        keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if !self.lease.active.load(Ordering::Acquire) {
            unsafe {
                *effect = DROPEFFECT_NONE;
            }
            return Ok(());
        }
        let data = self.data.lock().ok().and_then(|data| data.clone());
        unsafe {
            *effect = if data.is_some() {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
        }
        if let Some(data) = data {
            self.send("over", point, keys, data);
        }
        Ok(())
    }
    fn DragLeave(&self) -> windows::core::Result<()> {
        if let Ok(mut data) = self.data.lock() {
            if let Some(data) = data.take() {
                self.send("leave", &POINTL { x: 0, y: 0 }, MODIFIERKEYS_FLAGS(0), data);
            }
        }
        Ok(())
    }
    fn Drop(
        &self,
        object: Ref<IDataObject>,
        keys: MODIFIERKEYS_FLAGS,
        point: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        if !self.lease.active.load(Ordering::Acquire) {
            unsafe {
                *effect = DROPEFFECT_NONE;
            }
            return Ok(());
        }
        let data = object.as_ref().and_then(|object| payload(object).ok());
        unsafe {
            *effect = if data.is_some() {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
        }
        if let Some(data) = data {
            self.send("drop", point, keys, data);
        }
        if let Ok(mut data) = self.data.lock() {
            *data = None;
        }
        Ok(())
    }
}
struct Controller {
    root: isize,
    lease: Arc<Lease>,
    targets: Vec<(isize, IDropTarget)>,
    _listener: Arc<Listener>,
}
thread_local! {static CONTROLLERS:RefCell<HashMap<String,Controller>>=RefCell::new(HashMap::new());}
impl Drop for Controller {
    fn drop(&mut self) {
        self.lease.active.store(false, Ordering::Release);
        unsafe {
            let key = w!("NabbitOwnedFileDrop");
            let root = HWND(self.root as _);
            if !std::ptr::eq(
                GetPropW(root, key).0.cast_const(),
                Arc::as_ptr(&self.lease).cast(),
            ) {
                return;
            }
            for (child, _) in &self.targets {
                let child = HWND(*child as _);
                if IsChild(root, child).as_bool() {
                    let _ = RevokeDragDrop(child);
                }
            }
            let _ = RemovePropW(root, key);
        }
    }
}
unsafe extern "system" fn children(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    unsafe {
        let children = &mut *(lparam.0 as *mut Vec<isize>);
        children.push(hwnd.0 as isize);
    }
    true.into()
}
pub fn install(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let root = hwnd.0 as isize;
    let label = window.label().to_owned();
    let app = window.app_handle().clone();
    let lease = Arc::new(Lease {
        active: AtomicBool::new(true),
        targets: AtomicUsize::new(0),
    });
    if let Ok(mut leases) = LEASES.get_or_init(Default::default).lock() {
        if let Some(old) = leases.insert(label.clone(), lease.clone()) {
            old.active.store(false, Ordering::Release);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let errors = app.clone();
        let result = crate::shell::run(move || {
            if !lease.active.load(Ordering::Acquire) {
                return Ok(());
            }
            CONTROLLERS.with(|controllers| {
                controllers.borrow_mut().remove(&label);
            });
            let target = label.clone();
            let callback: Arc<Listener> = Arc::new(move |event| {
                if let Some(manager) = app.try_state::<Arc<crate::island::Manager>>() {
                    if manager.file_surface_active(&target) {
                        let _ = app.emit_to(target.as_str(), "nabbit://native-drop", event);
                    }
                }
            });
            let mut controller = Controller {
                root,
                lease: lease.clone(),
                targets: Vec::new(),
                _listener: callback.clone(),
            };
            unsafe {
                if !IsWindow(Some(HWND(root as _))).as_bool() {
                    return Err(msg("Nabbit drop window closed"));
                }
                let mut process = 0;
                GetWindowThreadProcessId(HWND(root as _), Some(&mut process));
                if process != std::process::id() || !lease.active.load(Ordering::Acquire) {
                    return Err(msg("The owned drop window changed"));
                }
                SetPropW(
                    HWND(root as _),
                    w!("NabbitOwnedFileDrop"),
                    Some(windows::Win32::Foundation::HANDLE(Arc::as_ptr(&lease) as _)),
                )
                .map_err(|e| msg(e.to_string()))?;
                let mut descendants = Vec::<isize>::new();
                let _ = EnumChildWindows(
                    Some(HWND(root as _)),
                    Some(children),
                    LPARAM((&mut descendants as *mut Vec<isize>) as isize),
                );
                for child in descendants {
                    if !IsChild(HWND(root as _), HWND(child as _)).as_bool() {
                        continue;
                    }
                    let drop: IDropTarget = Target {
                        root,
                        lease: lease.clone(),
                        listener: Arc::downgrade(&callback),
                        data: Mutex::new(None),
                    }
                    .into();
                    let _ = RevokeDragDrop(HWND(child as _));
                    if RegisterDragDrop(HWND(child as _), &drop).is_ok() {
                        controller.targets.push((child, drop));
                    }
                }
            }
            lease
                .targets
                .store(controller.targets.len(), Ordering::Release);
            if controller.targets.is_empty() {
                return Err(msg("Nabbit file drop targets could not be registered"));
            }
            CONTROLLERS.with(|controllers| {
                controllers.borrow_mut().insert(label, controller);
            });
            Ok(())
        });
        if let Err(error) = result {
            let _ = errors.emit("capture:error", error.to_string());
        }
    });
}
pub fn close(owner: &str) {
    if let Some(leases) = LEASES.get() {
        if let Ok(mut leases) = leases.lock() {
            if let Some(lease) = leases.remove(owner) {
                lease.active.store(false, Ordering::Release);
            }
        }
    }
    let owner = owner.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::shell::run(move || {
            CONTROLLERS.with(|controllers| {
                controllers.borrow_mut().remove(&owner);
            });
            Ok(())
        });
    });
}
pub fn count(owner: &str) -> usize {
    LEASES
        .get()
        .and_then(|leases| leases.lock().ok())
        .and_then(|leases| {
            leases
                .get(owner)
                .map(|lease| lease.targets.load(Ordering::Acquire))
        })
        .unwrap_or(0)
}
pub fn fixture_event(
    path: String,
    kind: String,
    x: i32,
    y: i32,
    modifiers: super::Modifiers,
    root: isize,
) -> Result<Event> {
    crate::shell::run(move || {
        let events = Arc::new(Mutex::new(Vec::<Event>::new()));
        let record = events.clone();
        let listener: Arc<Listener> = Arc::new(move |event| {
            if let Ok(mut events) = record.lock() {
                events.push(event);
            }
        });
        let target: IDropTarget = Target {
            root,
            lease: Arc::new(Lease {
                active: AtomicBool::new(true),
                targets: AtomicUsize::new(0),
            }),
            listener: Arc::downgrade(&listener),
            data: Mutex::new(None),
        }
        .into();
        unsafe {
            let item: IShellItem =
                SHCreateItemFromParsingName(&super::native::shell_name(&path)?, None)
                    .map_err(|e| msg(format!("Owned Shell item: {e}")))?;
            let items: IShellItemArray = SHCreateShellItemArrayFromShellItem(&item)
                .map_err(|e| msg(format!("Owned Shell array: {e}")))?;
            let object: IDataObject = items
                .BindToHandler(None, &BHID_DataObject)
                .map_err(|e| msg(format!("Owned drag data object: {e}")))?;
            let mut point = POINT { x, y };
            if root != 0 {
                let _ = windows::Win32::Graphics::Gdi::ClientToScreen(HWND(root as _), &mut point);
            }
            let point = POINTL {
                x: point.x,
                y: point.y,
            };
            let keys = MODIFIERKEYS_FLAGS(
                if modifiers.shift { 4 } else { 0 } | if modifiers.ctrl { 8 } else { 0 },
            );
            let mut effect = DROPEFFECT_COPY;
            target
                .DragEnter(&object, keys, point, &mut effect)
                .map_err(|e| msg(e.to_string()))?;
            match kind.as_str() {
                "enter" => (),
                "over" => target
                    .DragOver(keys, point, &mut effect)
                    .map_err(|e| msg(e.to_string()))?,
                "drop" => target
                    .Drop(&object, keys, point, &mut effect)
                    .map_err(|e| msg(e.to_string()))?,
                "leave" => target.DragLeave().map_err(|e| msg(e.to_string()))?,
                _ => return Err(msg("Invalid fixture drag phase")),
            }
        }
        let event = events
            .lock()
            .map_err(|_| msg("Fixture drag unavailable"))?
            .last()
            .cloned()
            .ok_or_else(|| msg("Fixture has no disk path"))?;
        Ok(event)
    })
}
pub fn stop() {
    if let Some(leases) = LEASES.get() {
        if let Ok(mut leases) = leases.lock() {
            for lease in leases.values() {
                lease.active.store(false, Ordering::Release);
            }
            leases.clear();
        }
    }
    let _ = crate::shell::run(|| {
        CONTROLLERS.with(|controllers| controllers.borrow_mut().clear());
        Ok(())
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_unicode_data_objects_keep_links_and_text_without_using_the_clipboard() {
        crate::shell::run(|| unsafe {
            for text in [
                "https://example.invalid/owned-drag",
                "বাংলা note from an owned data object",
            ] {
                let object: IDataObject = SHCreateDataObject(None, None, None::<&IDataObject>)
                    .map_err(|e| msg(e.to_string()))?;
                let chars: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
                let memory =
                    GlobalAlloc(GMEM_MOVEABLE, chars.len() * 2).map_err(|e| msg(e.to_string()))?;
                let pointer = GlobalLock(memory);
                assert!(!pointer.is_null());
                std::ptr::copy_nonoverlapping(chars.as_ptr(), pointer.cast(), chars.len());
                let _ = GlobalUnlock(memory);
                let format = FORMATETC {
                    cfFormat: 13,
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_HGLOBAL.0 as u32,
                    ..Default::default()
                };
                let medium = STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: STGMEDIUM_0 { hGlobal: memory },
                    pUnkForRelease: std::mem::ManuallyDrop::new(None),
                };
                object
                    .SetData(&format, &medium, true)
                    .map_err(|e| msg(e.to_string()))?;
                let result = payload(&object)?;
                assert!(result.files.is_empty());
                assert_eq!(result.text.as_deref(), Some(text));
            }
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn owned_sta_window_registers_revokes_and_stale_target_rejects_data() {
        crate::shell::run(|| unsafe {
            let hwnd = CreateWindowExW(
                Default::default(),
                w!("STATIC"),
                w!("Nabbit owned OLE fixture"),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                None,
                None,
            )
            .map_err(|e| msg(e.to_string()))?;
            let lease = Arc::new(Lease {
                active: AtomicBool::new(true),
                targets: AtomicUsize::new(0),
            });
            let listener: Arc<Listener> = Arc::new(|_| panic!("No real input should arrive"));
            let target: IDropTarget = Target {
                root: hwnd.0 as isize,
                lease: lease.clone(),
                listener: Arc::downgrade(&listener),
                data: Mutex::new(None),
            }
            .into();
            RegisterDragDrop(hwnd, &target).map_err(|e| msg(e.to_string()))?;
            RevokeDragDrop(hwnd).map_err(|e| msg(e.to_string()))?;
            lease.active.store(false, Ordering::Release);
            let mut effect = DROPEFFECT_COPY;
            target
                .DragEnter(
                    None::<&IDataObject>,
                    MODIFIERKEYS_FLAGS(0),
                    POINTL { x: 0, y: 0 },
                    &mut effect,
                )
                .map_err(|e| msg(e.to_string()))?;
            assert_eq!(effect, DROPEFFECT_NONE);
            DestroyWindow(hwnd).map_err(|e| msg(e.to_string()))?;
            Ok(())
        })
        .unwrap();
    }
}
