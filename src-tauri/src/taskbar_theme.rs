//! Windows taskbar appearance is independent of AppsUseLightTheme and Nabbit's
//! saved preference. One blocked native wait, no timers and no registry writes.
use crate::tray_icon::TaskbarTheme;
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
};
use windows_sys::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{ERROR_SUCCESS, WAIT_OBJECT_0},
        System::{
            Registry::{
                RegCloseKey, RegGetValueW, RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY,
                HKEY_CURRENT_USER, KEY_NOTIFY, KEY_QUERY_VALUE, REG_NOTIFY_CHANGE_LAST_SET,
                REG_NOTIFY_THREAD_AGNOSTIC, RRF_RT_REG_DWORD,
            },
            Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE},
        },
    },
};

const THEMES: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes");

// Registry handles have their own close API; unlike OwnedHandle, this guard
// must use RegCloseKey. The handle is moved to one persistent watcher thread.
struct Key(usize);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0 as HKEY) };
    }
}
impl Key {
    fn open(path: PCWSTR) -> io::Result<Self> {
        let mut key = ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                path,
                0,
                KEY_QUERY_VALUE | KEY_NOTIFY,
                &mut key,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(Self(key as usize))
    }

    fn theme(&self) -> TaskbarTheme {
        let mut value = 0u32;
        let mut size = size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                self.0 as HKEY,
                w!("Personalize"),
                w!("SystemUsesLightTheme"),
                RRF_RT_REG_DWORD,
                ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        TaskbarTheme::from_system_light((status == ERROR_SUCCESS).then_some(value))
    }
}

fn event() -> io::Result<OwnedHandle> {
    let handle = unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn arm(key: &Key, changed: &OwnedHandle) -> io::Result<()> {
    let status = unsafe {
        RegNotifyChangeKeyValue(
            key.0 as HKEY,
            1,
            REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_THREAD_AGNOSTIC,
            changed.as_raw_handle(),
            1,
        )
    };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

pub fn current() -> TaskbarTheme {
    Key::open(THEMES)
        .map(|key| key.theme())
        .unwrap_or(TaskbarTheme::Dark)
}

pub struct Watcher {
    stop: Arc<OwnedHandle>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Watcher {
    pub fn start(on_change: impl Fn(TaskbarTheme) + Send + 'static) -> io::Result<Self> {
        Self::watch(Key::open(THEMES)?, on_change)
    }

    fn watch(key: Key, on_change: impl Fn(TaskbarTheme) + Send + 'static) -> io::Result<Self> {
        let changed = event()?;
        let stop = Arc::new(event()?);
        // Arm before the first read so a change between startup and the wait
        // cannot be lost. Re-arm once per completed notification, before reading.
        arm(&key, &changed)?;
        let worker_stop = stop.clone();
        let worker = thread::Builder::new()
            .name("nabbit-taskbar-theme".into())
            .spawn(move || {
                let mut previous = key.theme();
                on_change(previous);
                let handles = [worker_stop.as_raw_handle(), changed.as_raw_handle()];
                loop {
                    let signaled =
                        unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
                    if signaled != WAIT_OBJECT_0 + 1 {
                        break;
                    }
                    if let Err(error) = arm(&key, &changed) {
                        eprintln!("Taskbar theme watch ended: {error}");
                        break;
                    }
                    let theme = key.theme();
                    if theme != previous {
                        previous = theme;
                        on_change(theme);
                    }
                }
            })?;
        Ok(Self {
            stop,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn stop(&self) {
        unsafe { SetEvent(self.stop.as_raw_handle()) };
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};
    use windows_sys::Win32::System::Registry::{
        RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, KEY_ALL_ACCESS, REG_DWORD,
        REG_OPTION_NON_VOLATILE,
    };

    struct Fixture {
        path: Vec<u16>,
        key: Key,
        personalize: Key,
    }
    impl Fixture {
        fn new() -> Self {
            // Only this disposable Nabbit-owned key is ever written. Never the
            // real Themes key or any Windows/user appearance setting.
            let path: Vec<_> = format!("Software\\Nabbit\\Tests\\{}", uuid::Uuid::new_v4())
                .encode_utf16()
                .chain([0])
                .collect();
            fn create(parent: HKEY, path: PCWSTR) -> Key {
                let mut key = ptr::null_mut();
                assert_eq!(
                    unsafe {
                        RegCreateKeyExW(
                            parent,
                            path,
                            0,
                            ptr::null_mut(),
                            REG_OPTION_NON_VOLATILE,
                            KEY_ALL_ACCESS,
                            ptr::null(),
                            &mut key,
                            ptr::null_mut(),
                        )
                    },
                    ERROR_SUCCESS
                );
                Key(key as usize)
            }
            let key = create(HKEY_CURRENT_USER, path.as_ptr());
            let personalize = create(key.0 as HKEY, w!("Personalize"));
            Self {
                path,
                key,
                personalize,
            }
        }
        fn set(&self, name: PCWSTR, value: u32) {
            assert_eq!(
                unsafe {
                    RegSetValueExW(
                        self.personalize.0 as HKEY,
                        name,
                        0,
                        REG_DWORD,
                        (&value as *const u32).cast(),
                        4,
                    )
                },
                ERROR_SUCCESS
            );
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(
                unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, self.path.as_ptr()) },
                ERROR_SUCCESS
            );
        }
    }

    #[test]
    fn real_notifications_follow_system_ignore_apps_deduplicate_and_stop() {
        let fixture = Fixture::new();
        fixture.set(w!("SystemUsesLightTheme"), 0);
        fixture.set(w!("AppsUseLightTheme"), 1);
        let (send, receive) = mpsc::channel();
        let watcher = Watcher::watch(Key::open(fixture.path.as_ptr()).unwrap(), move |theme| {
            send.send(theme).unwrap();
        })
        .unwrap();
        let next = || receive.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(next(), TaskbarTheme::Dark);
        fixture.set(w!("AppsUseLightTheme"), 0);
        assert!(receive.recv_timeout(Duration::from_millis(150)).is_err());
        fixture.set(w!("SystemUsesLightTheme"), 1);
        assert_eq!(next(), TaskbarTheme::Light);
        fixture.set(w!("SystemUsesLightTheme"), 1);
        assert!(receive.recv_timeout(Duration::from_millis(150)).is_err());
        fixture.set(w!("SystemUsesLightTheme"), 0);
        assert_eq!(next(), TaskbarTheme::Dark);
        watcher.stop();
        fixture.set(w!("SystemUsesLightTheme"), 1);
        assert!(matches!(
            receive.recv_timeout(Duration::from_millis(150)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
        // Stop and Drop can both run; all watcher handles are released once.
        watcher.stop();
        assert_eq!(fixture.key.theme(), TaskbarTheme::Light);
    }
}
