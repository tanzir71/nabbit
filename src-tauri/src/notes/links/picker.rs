use crate::error::{msg, Result};
use std::path::PathBuf;
#[cfg(windows)]
pub fn html(owner: isize) -> Result<Option<PathBuf>> {
    // A dedicated STA owns the dialog and all COM objects. No clipboard or
    // simulated keyboard input is involved; tests inject a fixture path.
    std::thread::Builder::new()
        .name("bookmark-file-picker".into())
        .spawn(move || unsafe {
            use windows::{
                core::w,
                Win32::{
                    Foundation::HWND,
                    System::Com::{
                        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
                    },
                    UI::Shell::{
                        Common::COMDLG_FILTERSPEC, FileOpenDialog, IFileOpenDialog,
                        FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST,
                        SIGDN_FILESYSPATH,
                    },
                },
            };
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|_| msg("The bookmark file picker is unavailable"))?;
            struct Apartment;
            impl Drop for Apartment {
                fn drop(&mut self) {
                    unsafe {
                        CoUninitialize();
                    }
                }
            }
            let _apartment = Apartment;
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                    .map_err(|_| msg("The bookmark file picker is unavailable"))?;
            dialog
                .SetTitle(w!("Import bookmarks"))
                .map_err(|_| msg("The bookmark file picker is unavailable"))?;
            dialog
                .SetOptions(
                    FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR,
                )
                .map_err(|_| msg("The bookmark file picker is unavailable"))?;
            dialog
                .SetFileTypes(&[COMDLG_FILTERSPEC {
                    pszName: w!("Bookmarks HTML"),
                    pszSpec: w!("*.html;*.htm"),
                }])
                .map_err(|_| msg("The bookmark file picker is unavailable"))?;
            if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
                if error.code().0 as u32 == 0x800704c7 {
                    return Ok(None);
                }
                return Err(msg("Could not open the bookmark file picker"));
            }
            let item = dialog
                .GetResult()
                .map_err(|_| msg("No bookmark file was selected"))?;
            let raw = item
                .GetDisplayName(SIGDN_FILESYSPATH)
                .map_err(|_| msg("The selected file has no filesystem path"))?;
            let text = raw.to_string();
            CoTaskMemFree(Some(raw.0.cast()));
            Ok(Some(PathBuf::from(text.map_err(|_| {
                msg("The bookmark file path could not be read")
            })?)))
        })?
        .join()
        .map_err(|_| msg("The bookmark file picker stopped"))?
}
#[cfg(not(windows))]
pub fn html(_owner: isize) -> Result<Option<PathBuf>> {
    Err(msg(
        "Native bookmark file selection is currently available on Windows",
    ))
}
