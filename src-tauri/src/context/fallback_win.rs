//! Windows adapter for the explicit opt-in copy transaction. Tests exercise
//! owned media and the abstract port; they never call this clipboard/input port.
use super::*;
use crate::{db::Database, island::keyboard::WindowId};
use std::{
    collections::HashSet,
    ffi::c_void,
    mem::ManuallyDrop,
    time::{Duration, Instant},
};
use windows::core::Interface;
use windows::Win32::{
    Foundation::{HANDLE, HGLOBAL},
    Graphics::Gdi::{HBITMAP, HENHMETAFILE},
    System::{
        Com::*,
        Memory::GMEM_MOVEABLE,
        Ole::{
            OleDuplicateData, OleFlushClipboard, OleGetClipboard, OleSetClipboard,
            ReleaseStgMedium, CLIPBOARD_FORMAT,
        },
    },
    UI::{
        Accessibility::{CUIAutomation, IUIAutomation},
        Shell::SHCreateDataObject,
    },
};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    Graphics::Gdi as gdi,
    System::{
        DataExchange::GetClipboardSequenceNumber,
        Memory::{GlobalLock, GlobalSize, GlobalUnlock},
        Threading::*,
    },
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};
const LIMIT: usize = 128 * 1024 * 1024;
pub struct Native {
    db: Database,
    target: WindowId,
    original_sequence: u32,
    copied_sequence: Option<u32>,
    sent: bool,
}
pub struct Snapshot {
    data: Option<IDataObject>,
}
thread_local! {static RECOVERY:std::cell::RefCell<Option<(Snapshot,u32)>>=const{std::cell::RefCell::new(None)};}
enum Restored {
    Done,
    Changed,
    Busy,
}
fn restore_cache(snapshot: &Snapshot, expected: u32) -> Restored {
    let current = || {
        snapshot.data.as_ref().is_some_and(|data| unsafe {
            windows_sys::Win32::System::Ole::OleIsCurrentClipboard(data.as_raw()) == 0
        })
    };
    let mut placed = current();
    for attempt in 0..6 {
        if (!placed && sequence() != expected) || (placed && !current()) {
            return Restored::Changed;
        }
        if !placed {
            placed = unsafe { OleSetClipboard(snapshot.data.as_ref()).is_ok() };
            if placed && snapshot.data.is_none() {
                return Restored::Done;
            }
        }
        if placed && current() && unsafe { OleFlushClipboard().is_ok() } {
            return Restored::Done;
        }
        if attempt < 5 {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    Restored::Busy
}
pub(super) fn recover_pending() -> Result<()> {
    let pending = RECOVERY.with(|state| state.borrow_mut().take());
    let Some((snapshot, expected)) = pending else {
        super::PENDING.store(false, Ordering::Release);
        return Ok(());
    };
    match restore_cache(&snapshot, expected) {
        Restored::Done | Restored::Changed => {
            super::clear_suppression(expected);
            super::PENDING.store(false, Ordering::Release);
            Ok(())
        }
        Restored::Busy => {
            let expected = sequence();
            super::suppress(expected);
            RECOVERY.with(|state| *state.borrow_mut() = Some((snapshot, expected)));
            Err(msg("Windows is still keeping the clipboard busy"))
        }
    }
}
struct Medium {
    raw: STGMEDIUM,
    bytes: usize,
    owned: bool,
}
impl Drop for Medium {
    fn drop(&mut self) {
        if self.owned {
            unsafe {
                ReleaseStgMedium(&mut self.raw);
            }
        }
    }
}
fn error(e: impl std::fmt::Display) -> crate::error::NabbitError {
    msg(e.to_string())
}
fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}
fn transport(name: &str) -> bool {
    name.eq_ignore_ascii_case("DataObject") || name.eq_ignore_ascii_case("Ole Private Data")
}
fn name(format: u32) -> Result<String> {
    let name = clipboard_win::raw::format_name_big(format);
    if format >= 0xc000 && name.is_none() {
        return Err(msg("A clipboard format cannot be identified"));
    }
    Ok(name.unwrap_or_default())
}
fn ole_formats() -> Result<HashSet<u32>> {
    unsafe {
        let source = OleGetClipboard().map_err(error)?;
        let formats = source.EnumFormatEtc(DATADIR_GET.0 as u32).map_err(error)?;
        let mut ids = HashSet::new();
        loop {
            let mut format = FORMATETC::default();
            let mut fetched = 0;
            let status = formats.Next(std::slice::from_mut(&mut format), Some(&mut fetched));
            status.ok().map_err(error)?;
            if fetched == 0 {
                break;
            }
            let device = !format.ptd.is_null();
            if device {
                CoTaskMemFree(Some(format.ptd.cast()));
            }
            let id = u32::from(format.cfFormat);
            if transport(&name(id)?) {
                continue;
            }
            let supported = (TYMED_HGLOBAL.0 | TYMED_GDI.0 | TYMED_MFPICT.0 | TYMED_ENHMF.0) as u32;
            if device || format.lindex != -1 || format.tymed == 0 || format.tymed & !supported != 0
            {
                return Err(msg(
                    "This clipboard contains a format that cannot be fully restored",
                ));
            }
            ids.insert(id);
            if ids.len() > 128 {
                return Err(msg("The clipboard has too many formats to preserve"));
            }
        }
        Ok(ids)
    }
}
// The caller owns the handle, or holds the clipboard lock for its entire use.
unsafe fn duplicate(format: u32, source: *mut c_void) -> Result<Medium> {
    unsafe {
        let mut base = format;
        if (0x300..=0x3ff).contains(&format) {
            base = match gdi::GetObjectType(source) as i32 {
                gdi::OBJ_BITMAP => 2,
                gdi::OBJ_PAL => 9,
                gdi::OBJ_ENHMETAFILE => 14,
                _ => {
                    return Err(msg(
                        "A custom graphics clipboard format cannot be preserved",
                    ))
                }
            };
        }
        if format == 0x82 {
            base = 2;
        }
        if format == 0x83 {
            base = 3;
        }
        if format == 0x8e {
            base = 14;
        }
        let (tymed, bytes) = match base {
            2 => {
                let mut bitmap: gdi::BITMAP = std::mem::zeroed();
                if gdi::GetObjectW(
                    source,
                    std::mem::size_of_val(&bitmap) as i32,
                    (&mut bitmap as *mut gdi::BITMAP).cast(),
                ) == 0
                {
                    return Err(msg("A clipboard bitmap cannot be inspected"));
                }
                let height = bitmap
                    .bmHeight
                    .checked_abs()
                    .ok_or_else(|| msg("Invalid clipboard bitmap"))?
                    as u64;
                let bytes = (bitmap.bmWidthBytes as u64)
                    .checked_mul(height)
                    .filter(|b| *b > 0 && *b <= LIMIT as u64)
                    .ok_or_else(|| msg("The clipboard bitmap is too large"))?
                    as usize;
                (TYMED_GDI, bytes)
            }
            9 => {
                let mut entries = 0u16;
                if gdi::GetObjectW(source, 2, (&mut entries as *mut u16).cast()) == 0 {
                    return Err(msg("The clipboard palette cannot be inspected"));
                }
                (TYMED_GDI, usize::from(entries) * 4)
            }
            3 => {
                if GlobalSize(source)
                    < std::mem::size_of::<windows_sys::Win32::System::DataExchange::METAFILEPICT>()
                {
                    return Err(msg("The clipboard metafile is incomplete"));
                }
                let pointer = GlobalLock(source);
                if pointer.is_null() {
                    return Err(msg("The clipboard metafile is unavailable"));
                }
                let picture = std::ptr::read(
                    pointer.cast::<windows_sys::Win32::System::DataExchange::METAFILEPICT>(),
                );
                GlobalUnlock(source);
                let bytes = gdi::GetMetaFileBitsEx(picture.hMF, 0, std::ptr::null_mut()) as usize;
                if bytes == 0 || bytes > LIMIT {
                    return Err(msg("The clipboard metafile is too large"));
                }
                (TYMED_MFPICT, bytes)
            }
            14 => {
                let bytes = gdi::GetEnhMetaFileBits(source, 0, std::ptr::null_mut()) as usize;
                if bytes == 0 || bytes > LIMIT {
                    return Err(msg("The clipboard metafile is too large"));
                }
                (TYMED_ENHMF, bytes)
            }
            0x80 => return Err(msg("Owner-drawn clipboard data cannot be preserved")),
            _ => {
                let bytes = GlobalSize(source);
                if bytes == 0 || bytes > LIMIT {
                    return Err(msg("A clipboard format is unavailable or too large"));
                }
                (TYMED_HGLOBAL, bytes)
            }
        };
        let handle = if base == 14 {
            gdi::CopyEnhMetaFileW(source, std::ptr::null())
        } else {
            OleDuplicateData(HANDLE(source), CLIPBOARD_FORMAT(base as u16), GMEM_MOVEABLE).0
        };
        if handle.is_null() {
            return Err(msg("A clipboard format could not be copied safely"));
        }
        let data = if tymed == TYMED_GDI {
            STGMEDIUM_0 {
                hBitmap: HBITMAP(handle),
            }
        } else if tymed == TYMED_MFPICT {
            STGMEDIUM_0 {
                hMetaFilePict: handle,
            }
        } else if tymed == TYMED_ENHMF {
            STGMEDIUM_0 {
                hEnhMetaFile: HENHMETAFILE(handle),
            }
        } else {
            STGMEDIUM_0 {
                hGlobal: HGLOBAL(handle),
            }
        };
        Ok(Medium {
            raw: STGMEDIUM {
                tymed: tymed.0 as u32,
                u: data,
                pUnkForRelease: ManuallyDrop::new(None),
            },
            bytes,
            owned: true,
        })
    }
}
impl Native {
    pub fn new(db: Database, target: WindowId) -> Self {
        Self {
            db,
            target,
            original_sequence: 0,
            copied_sequence: None,
            sent: false,
        }
    }
    fn same_window(&self) -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            let mut process = 0;
            GetWindowThreadProcessId(hwnd, &mut process);
            hwnd as u64 == self.target.hwnd && process == self.target.process
        }
    }
    fn not_elevated(&self) -> bool {
        unsafe {
            use windows_sys::Win32::Security::{
                GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
            };
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, self.target.process);
            if process.is_null() {
                return false;
            }
            let mut token = std::ptr::null_mut();
            let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
            CloseHandle(process);
            if opened == 0 {
                return false;
            }
            let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
            let mut bytes = 0;
            let result = GetTokenInformation(
                token,
                TokenElevation,
                (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                std::mem::size_of_val(&elevation) as u32,
                &mut bytes,
            );
            CloseHandle(token);
            result != 0 && elevation.TokenIsElevated == 0
        }
    }
    fn private_clipboard(&self) -> Result<bool> {
        if super::super::clipboard::privacy_locked()?.blocked() {
            return Ok(true);
        }
        Ok(!self
            .db
            .clipboard_source_allowed(super::super::clipboard::source_app().as_deref())?)
    }
}
impl Port for Native {
    type Snapshot = Snapshot;
    fn eligible(&mut self) -> bool {
        if crate::context::acceptance() || !self.same_window() || !self.not_elevated() {
            return false;
        }
        let Some(source) = super::super::clipboard::process_name(self.target.process) else {
            return false;
        };
        if !self
            .db
            .clipboard_source_allowed(Some(&source))
            .unwrap_or(false)
        {
            return false;
        }
        unsafe {
            let Ok(automation) =
                CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            else {
                return false;
            };
            let Ok(element) = automation.GetFocusedElement() else {
                return false;
            };
            element.CurrentProcessId().ok() == Some(self.target.process as i32)
                && element.CurrentIsPassword().is_ok_and(|b| !b.as_bool())
                && self.same_window()
        }
    }
    fn snapshot(&mut self) -> Result<Snapshot> {
        recover_pending()?;
        let empty = {
            let _lock = clipboard_win::Clipboard::new().map_err(error)?;
            if self.private_clipboard()? {
                return Err(msg("The current clipboard is private"));
            }
            self.original_sequence = sequence();
            unsafe { windows_sys::Win32::System::DataExchange::CountClipboardFormats() == 0 }
        };
        if empty {
            return Ok(Snapshot { data: None });
        }
        let expected = ole_formats()?;
        let _lock = clipboard_win::Clipboard::new().map_err(error)?;
        if sequence() != self.original_sequence || self.private_clipboard()? {
            return Err(msg("The clipboard changed before it could be preserved"));
        }
        let mut formats = Vec::new();
        let mut format = 0;
        unsafe {
            loop {
                windows_sys::Win32::Foundation::SetLastError(0);
                let next = windows_sys::Win32::System::DataExchange::EnumClipboardFormats(format);
                if next == 0 {
                    if windows_sys::Win32::Foundation::GetLastError() != 0 {
                        return Err(msg("Not every clipboard format could be listed"));
                    }
                    break;
                }
                format = next;
                if !transport(&name(format)?) {
                    formats.push(format);
                }
                if formats.len() > 128 {
                    return Err(msg("The clipboard has too many formats to preserve"));
                }
            }
        }
        let actual = formats.iter().copied().collect::<HashSet<_>>();
        if !expected.is_subset(&actual)
            || formats
                .iter()
                .any(|&id| name(id).is_ok_and(|n| n.eq_ignore_ascii_case("FileContents")))
        {
            return Err(msg(
                "Virtual or unrendered clipboard formats cannot be fully restored",
            ));
        }
        let object: IDataObject =
            unsafe { SHCreateDataObject(None, None, None::<&IDataObject>).map_err(error)? };
        let mut total = 0usize;
        for format in formats {
            let source = clipboard_win::raw::get_clipboard_data(format).map_err(error)?;
            let mut medium = unsafe { duplicate(format, source.as_ptr())? };
            total = total.saturating_add(medium.bytes);
            if total > LIMIT {
                return Err(msg("The complete clipboard exceeds the restore limit"));
            }
            let descriptor = FORMATETC {
                cfFormat: format as u16,
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: medium.raw.tymed,
                ..Default::default()
            };
            unsafe {
                object
                    .SetData(&descriptor, &medium.raw, true)
                    .map_err(error)?;
            }
            medium.owned = false;
        }
        if sequence() != self.original_sequence || self.private_clipboard()? {
            return Err(msg("The clipboard changed while being preserved"));
        }
        Ok(Snapshot { data: Some(object) })
    }
    fn copy_selection(&mut self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_millis(500);
        while unsafe {
            [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
                .iter()
                .any(|&key| GetAsyncKeyState(key as i32) < 0)
        } {
            if Instant::now() >= deadline || !self.same_window() {
                return Err(msg("Release the shortcut keys and try again"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !self.eligible() || sequence() != self.original_sequence {
            return Err(msg("The selected app or clipboard changed"));
        }
        let key = |vk, flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [
            key(VK_CONTROL, 0),
            key(0x43, 0),
            key(0x43, KEYEVENTF_KEYUP),
            key(VK_CONTROL, KEYEVENTF_KEYUP),
        ];
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        };
        self.sent = sent > 0;
        if sent != inputs.len() as u32 {
            let release = [key(0x43, KEYEVENTF_KEYUP), key(VK_CONTROL, KEYEVENTF_KEYUP)];
            unsafe {
                SendInput(
                    release.len() as u32,
                    release.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                );
            }
            return Err(msg("The selected app did not accept Copy"));
        }
        let deadline = Instant::now() + Duration::from_millis(600);
        loop {
            let current = sequence();
            if current != self.original_sequence {
                self.copied_sequence = Some(current);
                return Ok(());
            }
            if Instant::now() >= deadline || !self.same_window() {
                return Err(msg("The selected app did not copy text"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn read_text(&mut self) -> Result<String> {
        let _lock = clipboard_win::Clipboard::new().map_err(error)?;
        if self.private_clipboard()? || self.copied_sequence != Some(sequence()) {
            return Err(msg("The copied selection is private or changed"));
        }
        if clipboard_win::raw::size(clipboard_win::formats::CF_UNICODETEXT)
            .is_none_or(|n| n.get() > 65538)
        {
            return Err(msg("The selected text is too large or unavailable"));
        }
        let mut bytes = Vec::new();
        clipboard_win::raw::get_string(&mut bytes).map_err(error)?;
        String::from_utf8(bytes).map_err(error)
    }
    fn restore(&mut self, snapshot: Snapshot) -> Result<()> {
        if !self.sent {
            return Ok(());
        }
        if self
            .copied_sequence
            .is_some_and(|expected| sequence() != expected)
        {
            return Err(msg("A newer clipboard copy was preserved"));
        }
        let expected = self.copied_sequence.unwrap_or_else(sequence);
        match restore_cache(&snapshot, expected) {
            Restored::Done => Ok(()),
            Restored::Changed => Err(msg("A newer clipboard copy was preserved")),
            Restored::Busy => {
                let expected = sequence();
                super::suppress(expected);
                RECOVERY.with(|state| *state.borrow_mut() = Some((snapshot, expected)));
                super::PENDING.store(true, Ordering::Release);
                Err(msg("Windows kept the clipboard busy; the original formats remain in memory for recovery"))
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Memory as memory;
    fn bytes(medium: &Medium) -> Vec<u8> {
        unsafe {
            let handle = medium.raw.u.hGlobal;
            let size = memory::GlobalSize(handle);
            let pointer = memory::GlobalLock(handle);
            assert!(!pointer.is_null());
            let bytes = std::slice::from_raw_parts(pointer.cast::<u8>(), size).to_vec();
            let _ = memory::GlobalUnlock(handle);
            bytes
        }
    }
    fn global(input: &[u8]) -> Medium {
        unsafe {
            let handle =
                memory::GlobalAlloc(memory::GMEM_MOVEABLE | memory::GMEM_ZEROINIT, input.len())
                    .unwrap();
            let pointer = memory::GlobalLock(handle);
            assert!(!pointer.is_null());
            std::ptr::copy_nonoverlapping(input.as_ptr(), pointer.cast(), input.len());
            let _ = memory::GlobalUnlock(handle);
            Medium {
                raw: STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: STGMEDIUM_0 { hGlobal: handle },
                    pUnkForRelease: ManuallyDrop::new(None),
                },
                bytes: input.len(),
                owned: true,
            }
        }
    }
    #[test]
    fn native_owned_all_format_cache_is_independent_and_byte_exact_without_using_the_clipboard() {
        crate::shell::run(|| unsafe {
            let object: IDataObject =
                SHCreateDataObject(None, None, None::<&IDataObject>).map_err(error)?;
            for (id, input) in [
                (13, b"o\0w\0n\0e\0d\0\0\0".as_slice()),
                (0xc041, b"<b>owned HTML</b>"),
                (0xc042, br"{\rtf1 owned}"),
                (8, b"owned DIB image bytes"),
                (0xc043, b"owned PNG image bytes"),
                (15, b"owned HDROP path-list bytes"),
                (0xc044, b"\0opaque\xffcustom\0"),
            ] {
                let original = global(input);
                let original_bytes = bytes(&original);
                let mut copy = duplicate(id, original.raw.u.hGlobal.0)?;
                let format = FORMATETC {
                    cfFormat: id as u16,
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_HGLOBAL.0 as u32,
                    ..Default::default()
                };
                object.SetData(&format, &copy.raw, true).map_err(error)?;
                copy.owned = false;
                let returned = Medium {
                    raw: object.GetData(&format).map_err(error)?,
                    bytes: input.len(),
                    owned: true,
                };
                let copied = bytes(&returned);
                assert!(copied.len() >= original_bytes.len());
                assert_eq!(&copied[..original_bytes.len()], original_bytes);
            }
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn native_owned_bitmap_and_enhanced_metafile_clones_keep_pixels_and_records() {
        crate::shell::run(|| unsafe {
            let pixels = (0..8 * 5 * 3).map(|n| (n * 7) as u8).collect::<Vec<_>>();
            let bitmap = gdi::CreateBitmap(8, 5, 1, 24, pixels.as_ptr().cast());
            assert!(!bitmap.is_null());
            let original = Medium {
                raw: STGMEDIUM {
                    tymed: TYMED_GDI.0 as u32,
                    u: STGMEDIUM_0 {
                        hBitmap: HBITMAP(bitmap),
                    },
                    pUnkForRelease: ManuallyDrop::new(None),
                },
                bytes: pixels.len(),
                owned: true,
            };
            let cloned = duplicate(2, bitmap)?;
            let read = |handle: *mut c_void| {
                let mut pixels = vec![0u8; 8 * 5 * 3];
                // Read the owned bitmap's raw storage without creating a DC
                // compatible with a user's screen or converting colour depth.
                let got =
                    gdi::GetBitmapBits(handle, pixels.len() as i32, pixels.as_mut_ptr().cast());
                if got != pixels.len() as i32 {
                    return Err(msg("Owned bitmap pixels were unavailable"));
                }
                Ok(pixels)
            };
            if read(original.raw.u.hBitmap.0)? != read(cloned.raw.u.hBitmap.0)? {
                return Err(msg("Owned bitmap clone pixels changed"));
            }
            let dc = gdi::CreateEnhMetaFileW(
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            );
            assert!(!dc.is_null());
            gdi::MoveToEx(dc, 1, 1, std::ptr::null_mut());
            gdi::LineTo(dc, 20, 30);
            let emf = gdi::CloseEnhMetaFile(dc);
            assert!(!emf.is_null());
            let original = Medium {
                raw: STGMEDIUM {
                    tymed: TYMED_ENHMF.0 as u32,
                    u: STGMEDIUM_0 {
                        hEnhMetaFile: HENHMETAFILE(emf),
                    },
                    pUnkForRelease: ManuallyDrop::new(None),
                },
                bytes: 0,
                owned: true,
            };
            let cloned = duplicate(14, emf)?;
            let read = |handle: *mut c_void| {
                let count = gdi::GetEnhMetaFileBits(handle, 0, std::ptr::null_mut());
                let mut bytes = vec![0u8; count as usize];
                assert_eq!(
                    gdi::GetEnhMetaFileBits(handle, count, bytes.as_mut_ptr()),
                    count
                );
                bytes
            };
            assert_eq!(
                read(original.raw.u.hEnhMetaFile.0),
                read(cloned.raw.u.hEnhMetaFile.0)
            );
            Ok(())
        })
        .unwrap();
    }
}
