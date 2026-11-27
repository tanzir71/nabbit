use crate::error::{msg, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};
pub fn hash(path: &Path) -> Result<String> {
    hash_with_cancel(path, None)
}
pub fn hash_with_cancel(
    path: &Path,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String> {
    let mut f = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    loop {
        if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire)) {
            return Err(msg("Cancelled"));
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn input(path: &Path) -> Result<File> {
    if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0') {
        return Err(msg("Choose an absolute file path"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(msg("Choose a file"));
    }
    Ok(file)
}
/// Publication never replaces an existing directory entry, including on FAT/exFAT.
pub fn publish(
    temp: &Path,
    source: &Path,
    preset: &str,
    extension: &str,
    mut prepare: impl FnMut(&Path) -> Result<()>,
) -> Result<PathBuf> {
    let parent = source
        .parent()
        .ok_or_else(|| msg("The file has no parent folder"))?;
    let stem = source
        .file_stem()
        .ok_or_else(|| msg("The file has no name"))?
        .to_string_lossy();
    for n in 1..=10000 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!(" {n}")
        };
        let path = parent.join(format!("{stem} ({preset}){suffix}.{extension}"));
        prepare(&path)?;
        #[cfg(windows)]
        let published = {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
            let from = temp
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let to = path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>();
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } != 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        };
        #[cfg(not(windows))]
        let published = fs::hard_link(temp, &path);
        match published {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) if path.exists() => continue,
            Err(e) => return Err(msg(format!("Could not safely create the output: {e}"))),
        }
    }
    Err(msg("Too many output name clashes"))
}
pub fn identity(path: &Path) -> Result<String> {
    let file = File::open(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let info = file.metadata()?;
        Ok(format!("{}:{}", info.dev(), info.ino()))
    }
}
pub fn dates(source: &File, output: &Path) -> Result<()> {
    let meta = source.metadata()?;
    let output = OpenOptions::new().write(true).open(output)?;
    output.set_times(fs::FileTimes::new().set_modified(meta.modified()?))?;
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::{Foundation::FILETIME, Storage::FileSystem::SetFileTime};
        let created = meta.creation_time();
        let time = FILETIME {
            dwLowDateTime: created as u32,
            dwHighDateTime: (created >> 32) as u32,
        };
        if unsafe {
            SetFileTime(
                output.as_raw_handle(),
                &time,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}
pub fn reveal(path: &Path) -> Result<()> {
    let path = path.to_path_buf();
    crate::shell::run(move || reveal_inner(&path))
}
fn reveal_inner(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::System::Com::{
            CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName};
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| msg(e.to_string()))?;
            let mut pidl = std::ptr::null_mut();
            let result = SHParseDisplayName(
                &HSTRING::from(crate::files::paths::display(path)),
                None,
                &mut pidl,
                0,
                None,
            )
            .and_then(|_| SHOpenFolderAndSelectItems(pidl, None, 0));
            if !pidl.is_null() {
                CoTaskMemFree(Some(pidl.cast()));
            }
            CoUninitialize();
            result.map_err(|e| msg(e.to_string()))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        open::that(path.parent().ok_or_else(|| msg("No parent folder"))?)?;
        Ok(())
    }
}
pub fn recycle(path: &Path) -> Result<()> {
    let path = path.to_path_buf();
    crate::shell::run(move || recycle_inner(&path))
}
fn recycle_inner(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::{System::Com::*, UI::Shell::*};
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| msg(e.to_string()))?;
            let result = (|| -> windows::core::Result<()> {
                let op: IFileOperation =
                    CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
                op.SetOperationFlags(
                    FOF_ALLOWUNDO
                        | FOFX_RECYCLEONDELETE
                        | FOF_NOCONFIRMATION
                        | FOF_NOERRORUI
                        | FOFX_EARLYFAILURE
                        | FOF_SILENT,
                )?;
                let item: IShellItem = SHCreateItemFromParsingName(
                    &HSTRING::from(crate::files::paths::display(path)),
                    None,
                )?;
                op.DeleteItem(&item, None)?;
                op.PerformOperations()?;
                if op.GetAnyOperationsAborted()?.as_bool() {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x800704C7u32 as i32,
                    )));
                }
                Ok(())
            })();
            CoUninitialize();
            result
                .map_err(|e| msg(format!("Could not move the output to the Recycle Bin: {e}")))?;
            if path.try_exists()? {
                return Err(msg("The output could not be moved to the Recycle Bin"));
            }
            Ok(())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(msg("Recycle Bin Undo is available on Windows"))
    }
}
pub fn pick(tool: &super::registry::Tool) -> Result<Option<String>> {
    let tool = tool.clone();
    crate::shell::run(move || pick_inner(&tool))
}
fn pick_inner(tool: &super::registry::Tool) -> Result<Option<String>> {
    #[cfg(windows)]
    {
        use windows::{
            core::HSTRING,
            Win32::{
                System::Com::*,
                UI::Shell::{Common::COMDLG_FILTERSPEC, *},
            },
        };
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| msg(e.to_string()))?;
            let result = (|| -> windows::core::Result<Option<String>> {
                let dialog: IFileOpenDialog =
                    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
                let label = HSTRING::from("Supported files");
                let pattern = HSTRING::from(
                    tool.accepts
                        .filetypes
                        .iter()
                        .map(|ext| format!("*.{ext}"))
                        .collect::<Vec<_>>()
                        .join(";"),
                );
                dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                    pszName: windows::core::PCWSTR(label.as_ptr()),
                    pszSpec: windows::core::PCWSTR(pattern.as_ptr()),
                }])?;
                dialog.SetOptions(
                    FOS_FILEMUSTEXIST
                        | FOS_PATHMUSTEXIST
                        | FOS_FORCEFILESYSTEM
                        | FOS_DONTADDTORECENT,
                )?;
                match dialog.Show(None) {
                    Err(e) if e.code().0 == 0x800704C7u32 as i32 => return Ok(None),
                    result => result?,
                }
                let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
                let path = name.to_string();
                CoTaskMemFree(Some(name.0.cast()));
                Ok(Some(path?))
            })();
            CoUninitialize();
            result.map_err(|e| msg(format!("Could not choose the file: {e}")))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = tool;
        Err(msg("Enter the file path or choose from Shelf"))
    }
}
