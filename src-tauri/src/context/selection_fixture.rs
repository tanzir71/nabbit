//! Owned Win32 controls provide real TextPattern coverage without focus, input,
//! clipboard access, screenshots or reads from another application.
use crate::error::{msg, Result};
use windows::{
    core::Interface,
    Win32::{
        Foundation::HWND,
        System::Com::*,
        UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomation2},
    },
};
use windows_sys::Win32::{
    Foundation::FreeLibrary,
    System::LibraryLoader::{GetModuleHandleW, LoadLibraryW},
    UI::WindowsAndMessaging::*,
};
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
struct Control {
    window: isize,
    module: isize,
}
impl Drop for Control {
    fn drop(&mut self) {
        let window = self.window;
        let module = self.module;
        let _ = crate::shell::run(move || {
            unsafe {
                DestroyWindow(window as _);
                if module != 0 {
                    FreeLibrary(module as _);
                }
            }
            Ok(())
        });
    }
}
fn control(password: bool) -> Result<Control> {
    crate::shell::run(move || unsafe {
        let module = if password {
            std::ptr::null_mut()
        } else {
            LoadLibraryW(wide("Msftedit.dll").as_ptr())
        };
        if !password && module.is_null() {
            return Err(msg("The owned RichEdit fixture could not load"));
        }
        let class = wide(if password { "EDIT" } else { "RICHEDIT50W" });
        let title = wide("Owned selection বাংলা 🐇 fixture");
        // A hidden, nonactivating tool window. EM_SETSEL addresses only this handle.
        let window = CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP | if password { 0x20 } else { 0x4 },
            -20000,
            -20000,
            400,
            120,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        );
        if window.is_null() {
            if !module.is_null() {
                FreeLibrary(module);
            }
            return Err(msg("The owned selection control could not be created"));
        }
        let start = "Owned ".encode_utf16().count();
        let end = start + "selection বাংলা 🐇".encode_utf16().count();
        SendMessageW(window, 0x00b1, start, end as isize);
        Ok(Control {
            window: window as isize,
            module: module as isize,
        })
    })
}
pub(crate) fn verify() -> Result<String> {
    let password = control(true)?;
    let control = control(false)?;
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| msg(e.to_string()))?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| msg(e.to_string()))?;
        if let Ok(options) = automation.cast::<IUIAutomation2>() {
            let _ = options.SetConnectionTimeout(5000);
            let _ = options.SetTransactionTimeout(5000);
        }
        let element = automation
            .ElementFromHandle(HWND(control.window as _))
            .map_err(|e| msg(e.to_string()))?;
        let text = super::selection::element_text(&element)?
            .ok_or_else(|| msg("The owned edit control did not expose TextPattern"))?;
        if text != "selection বাংলা 🐇" {
            return Err(msg(format!(
                "The owned text range was unexpected: {text:?}"
            )));
        }
        let private = automation
            .ElementFromHandle(HWND(password.window as _))
            .map_err(|e| msg(e.to_string()))?;
        if super::selection::element_text(&private).is_ok() {
            return Err(msg("The owned password control was not rejected"));
        }
        Ok(text)
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn native_owned_uia_selection_and_password_policy_without_global_focus_or_clipboard() {
        assert_eq!(super::verify().unwrap(), "selection বাংলা 🐇");
    }
}
