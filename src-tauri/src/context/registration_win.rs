use super::*;
use windows::{
    core::{Interface, HSTRING},
    Win32::{
        System::Com::{
            CoCreateInstance, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ,
        },
        UI::Shell::{
            FOLDERID_SendTo, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT,
        },
    },
};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND},
    System::Registry::*,
};
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn checked(status: u32) -> Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(status as i32).into())
    }
}
pub struct Native {
    shortcut: std::path::PathBuf,
}
impl Native {
    pub fn new() -> Result<Self> {
        unsafe {
            let raw = SHGetKnownFolderPath(&FOLDERID_SendTo, KF_FLAG_DEFAULT, None)
                .map_err(|e| msg(e.to_string()))?;
            let result = raw.to_string();
            CoTaskMemFree(Some(raw.as_ptr().cast()));
            let directory = std::path::PathBuf::from(
                result.map_err(|_| msg("Send To folder name is invalid"))?,
            );
            if !directory.is_absolute() {
                return Err(msg("Send To folder is unavailable"));
            }
            Ok(Self {
                shortcut: directory.join("Nabbit.lnk"),
            })
        }
    }
    fn shortcut_exists(&self) -> Result<bool> {
        match std::fs::symlink_metadata(&self.shortcut) {
            Ok(metadata) => {
                use std::os::windows::fs::MetadataExt;
                if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
                    return Err(msg("The Send To shortcut is not a regular file"));
                }
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
}
impl Port for Native {
    fn exists(&mut self) -> Result<bool> {
        unsafe {
            let mut key = std::ptr::null_mut();
            let status = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wide(ROOT).as_ptr(),
                0,
                KEY_READ,
                &mut key,
            );
            if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
                return Ok(false);
            }
            checked(status).map_err(|e| msg(e.to_string()))?;
            RegCloseKey(key);
            Ok(true)
        }
    }
    fn get(&mut self, name: &str) -> Result<Option<String>> {
        unsafe {
            let mut bytes = 0;
            let key = wide(ROOT);
            let name = wide(name);
            let status = RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut bytes,
            );
            if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
                return Ok(None);
            }
            checked(status).map_err(|e| msg(e.to_string()))?;
            if bytes > 65536 || bytes % 2 != 0 {
                return Err(msg("Context registration value is too large"));
            }
            let mut value = vec![0u16; bytes as usize / 2];
            checked(RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                value.as_mut_ptr().cast(),
                &mut bytes,
            ))
            .map_err(|e| msg(e.to_string()))?;
            Ok(Some(
                String::from_utf16_lossy(&value)
                    .trim_end_matches('\0')
                    .into(),
            ))
        }
    }
    fn set(&mut self, value: &Value) -> Result<()> {
        if value.key != ROOT && !value.key.starts_with(&format!("{ROOT}\\")) {
            return Err(msg("Context registry path is outside the owned subtree"));
        }
        unsafe {
            let mut key = std::ptr::null_mut();
            checked(RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide(&value.key).as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            ))
            .map_err(|e| msg(e.to_string()))?;
            let data = wide(&value.value);
            let result = checked(RegSetValueExW(
                key,
                wide(value.name).as_ptr(),
                0,
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            ));
            RegCloseKey(key);
            result
        }
    }
    fn remove_menu(&mut self) -> Result<()> {
        unsafe {
            let status = RegDeleteTreeW(HKEY_CURRENT_USER, wide(ROOT).as_ptr());
            if matches!(status, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
                Ok(())
            } else {
                checked(status)
            }
        }
    }
    fn link(&mut self) -> Result<Option<Link>> {
        if !self.shortcut_exists()? {
            return Ok(None);
        }
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| msg(e.to_string()))?;
            let persist: IPersistFile = link.cast().map_err(|e| msg(e.to_string()))?;
            let loaded = persist
                .Load(
                    &HSTRING::from(self.shortcut.to_string_lossy().as_ref()),
                    STGM_READ,
                )
                .is_ok();
            let mut owner = vec![0u16; 1024];
            let mut target = vec![0u16; 32768];
            let mut arguments = vec![0u16; 32768];
            if !loaded
                || link.GetDescription(&mut owner).is_err()
                || link.GetPath(&mut target, std::ptr::null_mut(), 0).is_err()
                || link.GetArguments(&mut arguments).is_err()
            {
                // An unrecognised shortcut is foreign: preserve it, refuse an
                // enable request, and still allow our own menu to be removed.
                return Ok(Some(Link::default()));
            }
            let text = |v: Vec<u16>| {
                String::from_utf16_lossy(&v)
                    .trim_end_matches('\0')
                    .to_string()
            };
            Ok(Some(Link {
                owner: text(owner),
                target: text(target),
                arguments: text(arguments),
            }))
        }
    }
    fn save_link(&mut self, value: &Link) -> Result<()> {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| msg(e.to_string()))?;
            link.SetPath(&HSTRING::from(&value.target))
                .map_err(|e| msg(e.to_string()))?;
            link.SetArguments(&HSTRING::from(&value.arguments))
                .map_err(|e| msg(e.to_string()))?;
            link.SetDescription(&HSTRING::from(&value.owner))
                .map_err(|e| msg(e.to_string()))?;
            let persist: IPersistFile = link.cast().map_err(|e| msg(e.to_string()))?;
            persist
                .Save(
                    &HSTRING::from(self.shortcut.to_string_lossy().as_ref()),
                    true,
                )
                .map_err(|e| msg(e.to_string()))?;
            Ok(())
        }
    }
    fn remove_link(&mut self) -> Result<()> {
        if self.shortcut_exists()? {
            std::fs::remove_file(&self.shortcut).map_err(|e| msg(e.to_string()))?;
        }
        Ok(())
    }
}
