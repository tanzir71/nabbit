use crate::error::{msg, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
pub const RECALL: u32 = 0x00400000 | 0x00040000;
pub fn local_only<T>(facts: &Facts, read: impl FnOnce() -> Result<T>) -> Result<T> {
    if facts.attributes & (RECALL | 0x1000) != 0 {
        Err(msg(
            "This cloud-only file is not downloaded; its contents were not read",
        ))
    } else {
        read()
    }
}
pub fn long_path_policy(length: usize, enabled: bool) -> Result<()> {
    if length >= 260 && !enabled {
        Err(msg(
            "This path is too long. Enable Windows long paths or choose a shorter folder.",
        ))
    } else {
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub path: String,
    pub directory: bool,
    pub bytes: u64,
    pub modified: u64,
    pub attributes: u32,
    pub volume: String,
    pub network: bool,
    pub cloud: bool,
}
pub fn display(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        raw.strip_prefix(r"\\?\").unwrap_or(&raw).into()
    }
}
pub fn checked(raw: &str) -> Result<PathBuf> {
    if raw.len() > 32760 || raw.contains(['\0', '\n', '\r']) || !Path::new(raw).is_absolute() {
        return Err(msg("Choose an absolute file or folder path"));
    }
    #[cfg(windows)]
    {
        long_path_policy(raw.encode_utf16().count(), long_paths_enabled())?;
        if raw.starts_with(r"\\.\") {
            return Err(msg("Choose a filesystem path rather than a device path"));
        }
        let raw = raw.replace('/', "\\");
        if raw.starts_with(r"\\?\") {
            Ok(raw.into())
        } else if let Some(unc) = raw.strip_prefix(r"\\") {
            Ok(format!(r"\\?\UNC\{unc}").into())
        } else {
            Ok(format!(r"\\?\{raw}").into())
        }
    }
    #[cfg(not(windows))]
    Ok(raw.into())
}
pub fn canonical(raw: &str) -> Result<String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let path = checked(raw)?;
        let attributes = fs::symlink_metadata(&path)?.file_attributes();
        if cloud_attributes(&path, attributes) {
            use windows_sys::Win32::Storage::FileSystem::GetFullPathNameW;
            let input: Vec<u16> = path
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut output = vec![0u16; 32768];
            let length = unsafe {
                GetFullPathNameW(
                    input.as_ptr(),
                    output.len() as u32,
                    output.as_mut_ptr(),
                    std::ptr::null_mut(),
                )
            };
            if length == 0 || length as usize >= output.len() {
                return Err(msg(
                    "This cloud path cannot be normalized without opening it",
                ));
            }
            return Ok(display(Path::new(&String::from_utf16_lossy(
                &output[..length as usize],
            ))));
        }
    }
    Ok(display(&fs::canonicalize(checked(raw)?)?))
}
pub fn cloud_tag(tag: u32) -> bool {
    tag & !0x0000f000 == 0x9000001a
}
pub fn cloud_attributes(path: &Path, attributes: u32) -> bool {
    if attributes & (RECALL | 0x1000 | 0x80000 | 0x100000) != 0 {
        return true;
    }
    #[cfg(windows)]
    if attributes & 0x400 != 0 {
        unsafe {
            use windows_sys::Win32::{Foundation::INVALID_HANDLE_VALUE, Storage::FileSystem::*};
            let path: Vec<u16> = path
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut data: WIN32_FIND_DATAW = std::mem::zeroed();
            let handle = FindFirstFileW(path.as_ptr(), &mut data);
            if handle == INVALID_HANDLE_VALUE {
                return false;
            }
            FindClose(handle);
            return cloud_tag(data.dwReserved0);
        }
    }
    #[cfg(not(windows))]
    let _ = path;
    false
}
pub fn identity(raw: &str) -> Result<String> {
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::*;
        let file = fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(7)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(checked(raw)?)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(raw)?;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
}
pub fn facts(raw: &str) -> Result<Facts> {
    let path = checked(raw)?;
    let meta = fs::symlink_metadata(&path)?;
    if meta.file_type().is_symlink() {
        return Err(msg("Choose the file itself rather than a symbolic link"));
    }
    #[cfg(windows)]
    let attributes = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes()
    };
    #[cfg(not(windows))]
    let attributes = 0;
    // Cloud reparse points are metadata-only here. Other reparse targets are ambiguous.
    let cloud = cloud_attributes(&path, attributes);
    if attributes & 0x400 != 0 && !cloud {
        return Err(msg("This reparse-point path cannot be safely used"));
    }
    let path = display(&path);
    let (volume, network) = volume(&path)?;
    Ok(Facts {
        cloud: cloud || cloud_roots().iter().any(|r| inside(&path, r)),
        path,
        directory: meta.is_dir(),
        bytes: meta.len(),
        modified: meta
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .min(u64::MAX as u128) as u64,
        attributes,
        volume,
        network,
    })
}
pub fn inside(path: &str, root: &str) -> bool {
    #[cfg(windows)]
    let (path, root) = (
        path.replace('/', "\\").to_lowercase(),
        root.replace('/', "\\").to_lowercase(),
    );
    #[cfg(not(windows))]
    let (path, root) = (path.to_owned(), root.to_owned());
    let root = root.trim_end_matches(['\\', '/']);
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|s| s.starts_with(['\\', '/']))
}
#[cfg(windows)]
fn volume(raw: &str) -> Result<(String, bool)> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetVolumeInformationW, GetVolumeNameForVolumeMountPointW, GetVolumePathNameW,
    };
    let path = checked(raw)?;
    let path: Vec<u16> = path
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut root = vec![0u16; 32768];
    let mut serial = 0;
    unsafe {
        if GetVolumePathNameW(path.as_ptr(), root.as_mut_ptr(), root.len() as u32) == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let network = GetDriveTypeW(root.as_ptr()) == 4;
        let mut name = [0u16; 256];
        if GetVolumeNameForVolumeMountPointW(root.as_ptr(), name.as_mut_ptr(), name.len() as u32)
            != 0
        {
            let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
            return Ok((
                String::from_utf16_lossy(&name[..end]).to_lowercase(),
                network,
            ));
        }
        if GetVolumeInformationW(
            root.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        ) == 0
        {
            if network {
                return Ok((
                    String::from_utf16_lossy(
                        &root[..root.iter().position(|v| *v == 0).unwrap_or(0)],
                    )
                    .to_lowercase(),
                    true,
                ));
            }
            return Err(std::io::Error::last_os_error().into());
        }
        Ok((format!("{serial:x}"), network))
    }
}
#[cfg(not(windows))]
fn volume(raw: &str) -> Result<(String, bool)> {
    use std::os::unix::fs::MetadataExt;
    Ok((fs::metadata(raw)?.dev().to_string(), false))
}
#[cfg(windows)]
fn long_paths_enabled() -> bool {
    use windows_sys::Win32::System::Registry::*;
    let key: Vec<u16> = r"SYSTEM\CurrentControlSet\Control\FileSystem"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let value: Vec<u16> = "LongPathsEnabled".encode_utf16().chain(Some(0)).collect();
    let mut enabled = 0u32;
    let mut bytes = 4;
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut enabled as *mut u32).cast(),
            &mut bytes,
        ) == 0
            && enabled == 1
    }
}
pub fn cloud_roots() -> Vec<String> {
    if cfg!(test) || crate::island::acceptance_session() || crate::sticky::acceptance_enabled() {
        return Vec::new();
    }
    let mut roots: Vec<String> = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|v| v.to_string_lossy().into())
        .collect();
    #[cfg(windows)]
    roots.extend(registered_cloud_roots());
    roots.sort();
    roots.dedup();
    roots
}
#[cfg(windows)]
fn registered_cloud_roots() -> Vec<String> {
    use windows_sys::Win32::System::Registry::*;
    let mut roots = Vec::new();
    let name: Vec<u16> = r"Software\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        let mut key = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, name.as_ptr(), 0, KEY_READ, &mut key) != 0 {
            return roots;
        }
        for index in 0..512 {
            let mut child = [0u16; 512];
            let mut count = child.len() as u32;
            if RegEnumKeyExW(
                key,
                index,
                child.as_mut_ptr(),
                &mut count,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) != 0
            {
                break;
            }
            let sub = format!(
                "{}\\UserSyncRoots",
                String::from_utf16_lossy(&child[..count as usize])
            );
            let sub: Vec<u16> = sub.encode_utf16().chain(Some(0)).collect();
            let mut rootkey = std::ptr::null_mut();
            if RegOpenKeyExW(key, sub.as_ptr(), 0, KEY_READ, &mut rootkey) != 0 {
                continue;
            }
            for value in 0..64 {
                let mut sid = [0u16; 256];
                let mut n = sid.len() as u32;
                let mut data = vec![0u16; 32768];
                let mut bytes = (data.len() * 2) as u32;
                let mut kind = 0;
                if RegEnumValueW(
                    rootkey,
                    value,
                    sid.as_mut_ptr(),
                    &mut n,
                    std::ptr::null_mut(),
                    &mut kind,
                    data.as_mut_ptr().cast(),
                    &mut bytes,
                ) != 0
                {
                    break;
                }
                if kind == REG_SZ {
                    let n = data.iter().position(|v| *v == 0).unwrap_or(data.len());
                    roots.push(String::from_utf16_lossy(&data[..n]));
                }
            }
            RegCloseKey(rootkey);
        }
        RegCloseKey(key);
    }
    roots
}
