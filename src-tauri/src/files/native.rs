use super::{paths, Backend, Fingerprint, Verb};
use crate::error::{msg, Result};
pub struct Native {
    pub owner: isize,
}
#[cfg(windows)]
pub fn shell_name(path: &str) -> Result<windows::core::HSTRING> {
    // Shell namespace parsing uses DOS/UNC display names; Rust file I/O uses verbatim paths.
    Ok(windows::core::HSTRING::from(paths::display(
        &paths::checked(path)?,
    )))
}
pub fn backup(source: &str, destination: &std::path::Path) -> Result<()> {
    let source = paths::checked(source)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::CopyFileW(from.as_ptr(), to.as_ptr(), 1)
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        use std::os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        };
        use windows_sys::Win32::{
            Foundation::FILETIME,
            Storage::FileSystem::{SetFileTime, FILE_WRITE_ATTRIBUTES},
        };
        let metadata = std::fs::metadata(&source)?;
        let created = metadata.creation_time();
        let modified = metadata.last_write_time();
        let file = std::fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .share_mode(7)
            .open(destination)?;
        let created = FILETIME {
            dwLowDateTime: created as u32,
            dwHighDateTime: (created >> 32) as u32,
        };
        let modified = FILETIME {
            dwLowDateTime: modified as u32,
            dwHighDateTime: (modified >> 32) as u32,
        };
        if unsafe { SetFileTime(file.as_raw_handle(), &created, std::ptr::null(), &modified) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    {
        let mut from = std::fs::File::open(source)?;
        let mut to = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        std::io::copy(&mut from, &mut to)?;
        to.sync_all()?;
        crate::tools::files::dates(&from, destination)?;
    }
    Ok(())
}
impl Backend for Native {
    fn transfer(
        &self,
        source: &str,
        destination: &str,
        name: Option<&str>,
        verb: Verb,
    ) -> Result<Option<String>> {
        let (source, destination, name, owner) = (
            source.to_owned(),
            destination.to_owned(),
            name.map(str::to_owned),
            self.owner,
        );
        crate::shell::run(move || transfer(&source, &destination, name.as_deref(), verb, owner))
    }
    fn fingerprint(&self, path: &str) -> Result<Fingerprint> {
        let facts = paths::facts(path)?;
        paths::local_only(&facts, || {
            let path = paths::checked(path)?;
            Ok(Fingerprint {
                identity: crate::tools::files::identity(&path)?,
                hash: crate::tools::files::hash(&path)?,
            })
        })
    }
    fn recycle(&self, path: &str) -> Result<()> {
        crate::tools::files::recycle(&paths::checked(path)?)
    }
}
#[cfg(windows)]
mod win {
    use std::sync::{Arc, Mutex};
    use windows::{
        core::*,
        Win32::{System::Com::*, UI::Shell::*},
    };
    #[implement(IFileOperationProgressSink)]
    pub struct Sink {
        pub output: Arc<Mutex<Option<String>>>,
    }
    fn path(item: Ref<IShellItem>) -> Result<Option<String>> {
        let Some(item) = item.as_ref() else {
            return Ok(None);
        };
        unsafe {
            let raw = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let value = raw.to_string();
            CoTaskMemFree(Some(raw.0.cast()));
            Ok(Some(value?))
        }
    }
    #[allow(non_snake_case)]
    impl IFileOperationProgressSink_Impl for Sink_Impl {
        fn StartOperations(&self) -> Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, hrresult: HRESULT) -> Result<()> {
            hrresult.ok()
        }
        fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> Result<()> {
            Ok(())
        }
        fn PostRenameItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            hr: HRESULT,
            _: Ref<IShellItem>,
        ) -> Result<()> {
            hr.ok()
        }
        fn PreMoveItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
        ) -> Result<()> {
            Ok(())
        }
        fn PostMoveItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            hr: HRESULT,
            new: Ref<IShellItem>,
        ) -> Result<()> {
            hr.ok()?;
            *self
                .output
                .lock()
                .map_err(|_| Error::from_hresult(HRESULT(0x80004005u32 as i32)))? = path(new)?;
            Ok(())
        }
        fn PreCopyItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
        ) -> Result<()> {
            Ok(())
        }
        fn PostCopyItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            hr: HRESULT,
            new: Ref<IShellItem>,
        ) -> Result<()> {
            hr.ok()?;
            *self
                .output
                .lock()
                .map_err(|_| Error::from_hresult(HRESULT(0x80004005u32 as i32)))? = path(new)?;
            Ok(())
        }
        fn PreDeleteItem(&self, _: u32, _: Ref<IShellItem>) -> Result<()> {
            Ok(())
        }
        fn PostDeleteItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            hr: HRESULT,
            _: Ref<IShellItem>,
        ) -> Result<()> {
            hr.ok()
        }
        fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> Result<()> {
            Ok(())
        }
        fn PostNewItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: &PCWSTR,
            _: u32,
            hr: HRESULT,
            _: Ref<IShellItem>,
        ) -> Result<()> {
            hr.ok()
        }
        fn UpdateProgress(&self, _: u32, _: u32) -> Result<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> Result<()> {
            Ok(())
        }
    }
}
#[cfg(windows)]
fn transfer(
    source: &str,
    destination: &str,
    name: Option<&str>,
    verb: Verb,
    owner: isize,
) -> Result<Option<String>> {
    use windows::{
        core::{HSTRING, PCWSTR},
        Win32::{Foundation::HWND, System::Com::*, UI::Shell::*},
    };
    let source = shell_name(source)?;
    let destination = shell_name(destination)?;
    let name = name.map(HSTRING::from);
    let name = name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
    let output = std::sync::Arc::new(std::sync::Mutex::new(None));
    unsafe {
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| msg(e.to_string()))?;
        operation
            .SetOperationFlags(FOFX_ADDUNDORECORD | FOFX_NOMINIMIZEBOX)
            .map_err(|e| msg(e.to_string()))?;
        if owner != 0 {
            operation
                .SetOwnerWindow(HWND(owner as *mut _))
                .map_err(|e| msg(e.to_string()))?;
        }
        let from: IShellItem =
            SHCreateItemFromParsingName(&source, None).map_err(|e| msg(e.to_string()))?;
        let to: IShellItem =
            SHCreateItemFromParsingName(&destination, None).map_err(|e| msg(e.to_string()))?;
        let sink: IFileOperationProgressSink = win::Sink {
            output: output.clone(),
        }
        .into();
        match verb {
            Verb::Move => operation.MoveItem(&from, &to, name, &sink),
            Verb::Copy => operation.CopyItem(&from, &to, name, &sink),
        }
        .map_err(|e| msg(e.to_string()))?;
        let performed = operation.PerformOperations();
        let observed = output
            .lock()
            .map_err(|_| msg("File result unavailable"))?
            .is_some();
        if !observed {
            performed
                .map_err(|e| msg(format!("Windows could not finish the file operation: {e}")))?;
            if operation
                .GetAnyOperationsAborted()
                .map_err(|e| msg(e.to_string()))?
                .as_bool()
            {
                return Err(msg("The file operation was cancelled"));
            }
        }
    }
    let result = output
        .lock()
        .map_err(|_| msg("File result unavailable"))?
        .clone();
    Ok(result.map(|p| paths::display(std::path::Path::new(&p))))
}
#[cfg(not(windows))]
fn transfer(_: &str, _: &str, _: Option<&str>, _: Verb, _: isize) -> Result<Option<String>> {
    Err(msg("Native file moves are available on Windows"))
}

pub fn choose(folder: bool) -> Result<Option<String>> {
    crate::shell::run(move || {
        #[cfg(windows)]
        {
            use windows::{
                core::HSTRING,
                Win32::{System::Com::*, UI::Shell::*},
            };
            unsafe {
                let dialog: IFileOpenDialog =
                    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| msg(e.to_string()))?;
                dialog
                    .SetTitle(&HSTRING::from(if folder {
                        "Choose a folder"
                    } else {
                        "Choose a file"
                    }))
                    .map_err(|e| msg(e.to_string()))?;
                let mut flags = FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_DONTADDTORECENT;
                flags |= if folder {
                    FOS_PICKFOLDERS
                } else {
                    FOS_FILEMUSTEXIST
                };
                dialog.SetOptions(flags).map_err(|e| msg(e.to_string()))?;
                match dialog.Show(None) {
                    Err(e) if e.code().0 == 0x800704C7u32 as i32 => return Ok(None),
                    result => result.map_err(|e| msg(e.to_string()))?,
                }
                let name = dialog
                    .GetResult()
                    .and_then(|item| item.GetDisplayName(SIGDN_FILESYSPATH))
                    .map_err(|e| msg(e.to_string()))?;
                let value = name.to_string();
                CoTaskMemFree(Some(name.0.cast()));
                Ok(Some(value.map_err(|e| msg(e.to_string()))?))
            }
        }
        #[cfg(not(windows))]
        {
            let _ = folder;
            Err(msg("Enter an absolute path"))
        }
    })
}
pub fn known_folders() -> Result<Vec<(String, String)>> {
    crate::shell::run(move || {
        #[cfg(windows)]
        {
            use windows::Win32::{System::Com::CoTaskMemFree, UI::Shell::*};
            [
                ("Desktop", FOLDERID_Desktop),
                ("Downloads", FOLDERID_Downloads),
                ("Documents", FOLDERID_Documents),
            ]
            .into_iter()
            .map(|(label, id)| unsafe {
                let path = SHGetKnownFolderPath(&id, KF_FLAG_DEFAULT, None)
                    .map_err(|e| msg(e.to_string()))?;
                let value = path.to_string();
                CoTaskMemFree(Some(path.0.cast()));
                Ok((label.into(), value.map_err(|e| msg(e.to_string()))?))
            })
            .collect()
        }
        #[cfg(not(windows))]
        {
            Ok(Vec::new())
        }
    })
}
pub fn applications() -> (Option<String>, Option<String>) {
    let terminal = which::which("wt.exe")
        .ok()
        .map(|p| p.to_string_lossy().into());
    let code = which::which("code.exe")
        .ok()
        .or_else(|| {
            [
                std::env::var_os("LOCALAPPDATA").map(|p| {
                    std::path::PathBuf::from(p).join("Programs/Microsoft VS Code/Code.exe")
                }),
                std::env::var_os("ProgramFiles")
                    .map(|p| std::path::PathBuf::from(p).join("Microsoft VS Code/Code.exe")),
            ]
            .into_iter()
            .flatten()
            .find(|p| p.is_file())
        })
        .map(|p| p.to_string_lossy().into());
    (terminal, code)
}
pub fn action(path: String, action: String) -> Result<()> {
    crate::shell::run(move || {
        if action == "reveal" {
            return crate::tools::files::reveal(&paths::checked(&path)?);
        }
        #[cfg(windows)]
        {
            use windows::{
                core::{HSTRING, PCWSTR},
                Win32::{Foundation::HWND, UI::Shell::*},
            };
            unsafe {
                if action == "openWith" {
                    let file = HSTRING::from(&path);
                    return SHOpenWithDialog(
                        None,
                        &OPENASINFO {
                            pcszFile: PCWSTR(file.as_ptr()),
                            pcszClass: PCWSTR::null(),
                            oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_EXEC,
                        },
                    )
                    .map_err(|e| msg(e.to_string()));
                }
                let (terminal, code) = applications();
                let (file, args) = match action.as_str() {
                    "open" => (path.clone(), String::new()),
                    "terminal" => (
                        terminal.ok_or_else(|| msg("Windows Terminal is not installed"))?,
                        format!(
                            "-d {}",
                            quote(if std::path::Path::new(&path).is_dir() {
                                &path
                            } else {
                                std::path::Path::new(&path)
                                    .parent()
                                    .and_then(|p| p.to_str())
                                    .ok_or_else(|| msg("No parent folder"))?
                            })
                        ),
                    ),
                    "code" => (
                        code.ok_or_else(|| msg("Visual Studio Code is not installed"))?,
                        format!("-- {}", quote(&path)),
                    ),
                    _ => return Err(msg("Unknown pin action")),
                };
                let file = HSTRING::from(file);
                let args = HSTRING::from(args);
                let verb = HSTRING::from("open");
                let mut info = SHELLEXECUTEINFOW {
                    cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                    fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                    hwnd: HWND::default(),
                    lpVerb: PCWSTR(verb.as_ptr()),
                    lpFile: PCWSTR(file.as_ptr()),
                    lpParameters: PCWSTR(args.as_ptr()),
                    nShow: 1,
                    ..Default::default()
                };
                ShellExecuteExW(&mut info).map_err(|e| msg(e.to_string()))?;
                Ok(())
            }
        }
        #[cfg(not(windows))]
        {
            if action == "open" {
                open::that(path)?;
                Ok(())
            } else {
                Err(msg("This action is available on Windows"))
            }
        }
    })
}
#[cfg(windows)]
fn quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value.replace('"', "\\\"").trim_end_matches('\\').to_owned()
            + &"\\".repeat(value.chars().rev().take_while(|c| *c == '\\').count() * 2)
    )
}

pub fn thumbnail(path: String) -> Result<Option<String>> {
    crate::shell::run(move || {
        #[cfg(windows)]
        {
            use base64::Engine;
            use windows::Win32::{Foundation::SIZE, UI::Shell::*};
            use windows_sys::Win32::Graphics::Gdi::*;
            let facts = paths::facts(&path)?;
            unsafe {
                let factory: IShellItemImageFactory =
                    SHCreateItemFromParsingName(&shell_name(&path)?, None)
                        .map_err(|e| msg(e.to_string()))?;
                let flags = if facts.attributes & (paths::RECALL | 0x1000) != 0 {
                    SIIGBF_ICONONLY
                } else {
                    SIIGBF_INCACHEONLY | SIIGBF_THUMBNAILONLY
                };
                let bitmap = match factory.GetImage(SIZE { cx: 96, cy: 72 }, flags) {
                    Ok(bitmap) => bitmap,
                    Err(_) => return Ok(None),
                };
                let mut details: BITMAP = std::mem::zeroed();
                let result = (|| -> Result<Option<String>> {
                    if GetObjectW(
                        bitmap.0,
                        std::mem::size_of::<BITMAP>() as i32,
                        (&mut details as *mut BITMAP).cast(),
                    ) == 0
                    {
                        return Ok(None);
                    }
                    let (width, height) = (
                        details.bmWidth.unsigned_abs(),
                        details.bmHeight.unsigned_abs(),
                    );
                    if width == 0 || height == 0 || width > 256 || height > 256 {
                        return Ok(None);
                    }
                    let mut info: BITMAPINFO = std::mem::zeroed();
                    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                    info.bmiHeader.biWidth = width as i32;
                    info.bmiHeader.biHeight = -(height as i32);
                    info.bmiHeader.biPlanes = 1;
                    info.bmiHeader.biBitCount = 32;
                    let mut bytes = vec![0u8; (width * height * 4) as usize];
                    let dc = CreateCompatibleDC(std::ptr::null_mut());
                    let copied = GetDIBits(
                        dc,
                        bitmap.0,
                        0,
                        height,
                        bytes.as_mut_ptr().cast(),
                        &mut info,
                        DIB_RGB_COLORS,
                    );
                    DeleteDC(dc);
                    if copied == 0 {
                        return Ok(None);
                    }
                    for pixel in bytes.chunks_exact_mut(4) {
                        pixel.swap(0, 2);
                        if pixel[3] == 0 {
                            pixel[3] = 255;
                        }
                    }
                    let mut output = std::io::Cursor::new(Vec::new());
                    image::RgbaImage::from_raw(width, height, bytes)
                        .ok_or_else(|| msg("Icon unavailable"))?
                        .write_to(&mut output, image::ImageFormat::Png)
                        .map_err(|e| msg(e.to_string()))?;
                    Ok(Some(format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(output.into_inner())
                    )))
                })();
                DeleteObject(bitmap.0);
                result
            }
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Ok(None)
        }
    })
}
