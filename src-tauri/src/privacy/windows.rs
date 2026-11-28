//! A persistent registry notification and one-shot waits on matched processes.
//! Handles/registrations are owned by the worker and revoked before teardown.
use super::*;
use model::{Capability, Process, RegistrySnapshot, Usage};
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
    thread::JoinHandle,
};
use windows_sys::{
    core::w,
    Win32::{
        Foundation::{
            ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_KEY_DELETED,
            ERROR_NO_MORE_ITEMS, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, FILETIME,
            INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
        },
        Storage::{
            FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
            Packaging::Appx::GetPackageFamilyName,
        },
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Registry::*,
            Threading::*,
        },
    },
};
const ROOT: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore";
const LIMIT: usize = 4096;
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}
fn error(status: u32) -> io::Error {
    io::Error::from_raw_os_error(status as i32)
}
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}
impl Key {
    fn open(parent: HKEY, path: &str) -> io::Result<Self> {
        let mut h = ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                parent,
                wide(path).as_ptr(),
                0,
                KEY_READ | KEY_NOTIFY,
                &mut h,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(error(status));
        }
        Ok(Self(h))
    }
    fn qword(&self, name: &str) -> Option<u64> {
        let mut n = 0u64;
        let mut bytes = 8;
        (unsafe {
            RegGetValueW(
                self.0,
                ptr::null(),
                wide(name).as_ptr(),
                RRF_RT_REG_QWORD,
                ptr::null_mut(),
                (&mut n as *mut u64).cast(),
                &mut bytes,
            )
        } == ERROR_SUCCESS
            && bytes == 8)
            .then_some(n)
    }
    fn children(&self) -> io::Result<Vec<String>> {
        let mut names = vec![];
        for index in 0..=LIMIT as u32 {
            let mut name = [0u16; 256];
            let mut length = name.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    self.0,
                    index,
                    name.as_mut_ptr(),
                    &mut length,
                    ptr::null(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                return Ok(names);
            }
            // A notification can delete this subtree after we opened it. Its
            // tombstoned handle is an empty subtree, not a failed provider.
            if status == ERROR_KEY_DELETED {
                return Ok(Vec::new());
            }
            if status != ERROR_SUCCESS {
                return Err(error(status));
            }
            if names.len() == LIMIT {
                return Err(io::Error::other("Too many privacy entries"));
            }
            names.push(String::from_utf16_lossy(&name[..length as usize]));
        }
        unreachable!()
    }
    fn arm(&self, changed: &OwnedHandle) -> io::Result<()> {
        let status = unsafe {
            RegNotifyChangeKeyValue(
                self.0,
                1,
                REG_NOTIFY_CHANGE_NAME | REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_THREAD_AGNOSTIC,
                changed.as_raw_handle(),
                1,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(error(status));
        }
        Ok(())
    }
}
fn optional(parent: HKEY, path: &str) -> io::Result<Option<Key>> {
    match Key::open(parent, path) {
        Ok(k) => Ok(Some(k)),
        Err(e) if matches!(e.raw_os_error(),Some(n) if n==ERROR_FILE_NOT_FOUND as i32 || n==ERROR_PATH_NOT_FOUND as i32 || n==ERROR_KEY_DELETED as i32) => {
            Ok(None)
        }
        Err(e) => Err(e),
    }
}
fn watch_root(root: &str) -> io::Result<Key> {
    let mut path = root;
    loop {
        if let Some(key) = optional(HKEY_CURRENT_USER, path)? {
            return Ok(key);
        }
        path = path
            .rsplit_once('\\')
            .ok_or_else(|| io::Error::other("Missing registry ancestor"))?
            .0;
    }
}
fn entries(root: &str) -> io::Result<Vec<Usage>> {
    fn walk(
        key: &Key,
        path: String,
        capability: Capability,
        depth: usize,
        output: &mut Vec<Usage>,
        visited: &mut usize,
    ) -> io::Result<()> {
        *visited += 1;
        if *visited > LIMIT || depth > 8 {
            return Err(io::Error::other("Privacy registry limit"));
        }
        let start = key.qword("LastUsedTimeStart");
        let stop = key.qword("LastUsedTimeStop");
        if start.is_some() || stop.is_some() {
            output.push(Usage {
                capability,
                key: path.clone(),
                last_used_time_start: start,
                last_used_time_stop: stop,
            });
        }
        for name in key.children()? {
            if let Some(child) = optional(key.0, &name)? {
                walk(
                    &child,
                    if path.is_empty() {
                        name
                    } else {
                        format!("{path}\\{name}")
                    },
                    capability,
                    depth + 1,
                    output,
                    visited,
                )?;
            }
        }
        Ok(())
    }
    let mut result = vec![];
    let mut visited = 0;
    for (name, capability) in [
        ("microphone", Capability::Microphone),
        ("webcam", Capability::Camera),
    ] {
        if let Some(key) = optional(HKEY_CURRENT_USER, &format!("{root}\\{name}"))? {
            walk(
                &key,
                String::new(),
                capability,
                0,
                &mut result,
                &mut visited,
            )?;
        }
    }
    Ok(result)
}
fn event() -> io::Result<OwnedHandle> {
    let h = unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) };
    if h.is_null() {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(h) })
}
fn filetime(t: FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}
fn display_name(path: &str) -> String {
    // Read only bounded executable version metadata, never load/execute the DLL.
    let path_w = wide(path);
    let size = unsafe { GetFileVersionInfoSizeW(path_w.as_ptr(), ptr::null_mut()) };
    if (1..=1_048_576).contains(&size) {
        let mut data = vec![0u8; size as usize];
        if unsafe { GetFileVersionInfoW(path_w.as_ptr(), 0, size, data.as_mut_ptr().cast()) } != 0 {
            let mut translation = ptr::null_mut();
            let mut length = 0;
            if unsafe {
                VerQueryValueW(
                    data.as_ptr().cast(),
                    w!("\\VarFileInfo\\Translation"),
                    &mut translation,
                    &mut length,
                )
            } != 0
                && length >= 4
                && !translation.is_null()
            {
                let words = unsafe { std::slice::from_raw_parts(translation as *const u16, 2) };
                let field = wide(&format!(
                    "\\StringFileInfo\\{:04x}{:04x}\\FileDescription",
                    words[0], words[1]
                ));
                let mut value = ptr::null_mut();
                let mut count = 0;
                if unsafe {
                    VerQueryValueW(data.as_ptr().cast(), field.as_ptr(), &mut value, &mut count)
                } != 0
                    && (2..=1024).contains(&count)
                    && !value.is_null()
                {
                    let name = String::from_utf16_lossy(unsafe {
                        std::slice::from_raw_parts(value as *const u16, count as usize - 1)
                    });
                    if !name.trim().is_empty() {
                        return name;
                    }
                }
            }
        }
    }
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or("App")
        .trim_end_matches(".exe")
        .to_owned()
}
fn process(pid: u32, entries: &[Usage]) -> Option<Process> {
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if raw.is_null() {
        return None;
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
        return None;
    }
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(handle.as_raw_handle(), 0, path.as_mut_ptr(), &mut length)
    } == 0
    {
        return None;
    }
    let image = String::from_utf16_lossy(&path[..length as usize]);
    let mut length = 0;
    let package_family =
        if unsafe { GetPackageFamilyName(handle.as_raw_handle(), &mut length, ptr::null_mut()) }
            == ERROR_INSUFFICIENT_BUFFER
            && length <= 256
        {
            let mut family = vec![0u16; length as usize];
            (unsafe {
                GetPackageFamilyName(handle.as_raw_handle(), &mut length, family.as_mut_ptr())
            } == ERROR_SUCCESS)
                .then(|| String::from_utf16_lossy(&family[..length.saturating_sub(1) as usize]))
        } else {
            None
        };
    let mut created = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut user = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut created,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return None;
    }
    let mut process = Process {
        pid,
        display_name: String::new(),
        image,
        package_family,
        created_at: filetime(created),
        alive: true,
    };
    if !entries
        .iter()
        .any(|e| e.last_used_time_stop == Some(0) && model::matches(&e.key, &process))
    {
        return None;
    }
    process.display_name = display_name(&process.image);
    Some(process)
}
fn processes(entries: &[Usage]) -> io::Result<Vec<Process>> {
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut item: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    item.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut output = vec![];
    let mut more = unsafe { Process32FirstW(handle.as_raw_handle(), &mut item) };
    let mut count = 0;
    while more != 0 {
        count += 1;
        if count > LIMIT {
            return Err(io::Error::other("Process limit"));
        }
        if let Some(p) = process(item.th32ProcessID, entries) {
            output.push(p)
        }
        more = unsafe { Process32NextW(handle.as_raw_handle(), &mut item) };
    }
    Ok(output)
}
struct ExitWait {
    wait: windows_sys::Win32::Foundation::HANDLE,
    _context: Arc<OwnedHandle>,
    _process: OwnedHandle,
}
unsafe extern "system" fn exited(context: *mut std::ffi::c_void, _: u8) {
    let event = unsafe { &*(context as *const OwnedHandle) };
    unsafe { SetEvent(event.as_raw_handle()) };
}
impl ExitWait {
    fn new(expected: &Process, refresh: Arc<OwnedHandle>) -> io::Result<Self> {
        let raw = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                expected.pid,
            )
        };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let process = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut times: [FILETIME; 4] = unsafe { std::mem::zeroed() };
        let [created, exit, kernel, user] = &mut times;
        if unsafe { GetProcessTimes(process.as_raw_handle(), created, exit, kernel, user) } == 0
            || filetime(*created) != expected.created_at
        {
            return Err(io::Error::other("Process identity changed"));
        }
        let context = refresh;
        let mut wait = ptr::null_mut();
        if unsafe {
            RegisterWaitForSingleObject(
                &mut wait,
                process.as_raw_handle(),
                Some(exited),
                Arc::as_ptr(&context).cast(),
                INFINITE,
                WT_EXECUTEONLYONCE,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            wait,
            _context: context,
            _process: process,
        })
    }
}
impl Drop for ExitWait {
    fn drop(&mut self) {
        unsafe { UnregisterWaitEx(self.wait, INVALID_HANDLE_VALUE) };
    }
}
struct Worker {
    stop: Arc<OwnedHandle>,
    refresh: Arc<OwnedHandle>,
    join: JoinHandle<()>,
}
pub struct Provider {
    worker: Mutex<Option<Worker>>,
}
impl Provider {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            worker: Mutex::new(None),
        })
    }
}
type Read = Box<dyn Fn() -> io::Result<RegistrySnapshot> + Send>;
fn run(
    root: String,
    read: Read,
    stop: Arc<OwnedHandle>,
    refresh: Arc<OwnedHandle>,
    sink: Sink,
) -> io::Result<()> {
    let changed = event()?;
    let mut key = watch_root(&root)?;
    key.arm(&changed)?;
    let handles = [
        stop.as_raw_handle(),
        changed.as_raw_handle(),
        refresh.as_raw_handle(),
    ];
    let mut waits = Vec::<ExitWait>::new();
    loop {
        waits.clear();
        match read() {
            Ok(mut value) => {
                let active = model::resolve(&value);
                let mut failed = vec![];
                for process in value
                    .processes
                    .iter()
                    .filter(|p| active.pids.contains(&p.pid))
                {
                    match ExitWait::new(process, refresh.clone()) {
                        Ok(w) => waits.push(w),
                        Err(_) => failed.push(process.pid),
                    }
                }
                // If a process vanished before registration, do not leave it active.
                value.processes.retain(|p| !failed.contains(&p.pid));
                sink(Ok(value));
            }
            Err(_) => sink(Err("Mic/camera activity is unavailable.".into())),
        }
        let signal =
            unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) };
        if signal == WAIT_OBJECT_0 {
            return Ok(());
        }
        if signal == WAIT_OBJECT_0 + 1 {
            // Exactly one re-arm after consuming the previous notification.
            if key.arm(&changed).is_err() {
                key = watch_root(&root)?;
                key.arm(&changed)?;
            }
        } else if signal != WAIT_OBJECT_0 + 2 {
            return Err(io::Error::last_os_error());
        }
    }
}
impl PrivacyProvider for Provider {
    fn subscribe(&self, sink: Sink) -> Result<(), String> {
        let mut state = self.worker.lock().unwrap();
        if state.is_some() {
            return Err("Already subscribed".into());
        }
        let stop = Arc::new(event().map_err(|_| "Privacy event unavailable")?);
        let refresh = Arc::new(event().map_err(|_| "Privacy event unavailable")?);
        let s = stop.clone();
        let r = refresh.clone();
        let join = std::thread::Builder::new()
            .name("nabbit-privacy".into())
            .spawn(move || {
                let read: Read = Box::new(|| {
                    let entries = entries(ROOT)?;
                    let processes = if entries.iter().any(|e| e.last_used_time_stop == Some(0)) {
                        processes(&entries)?
                    } else {
                        vec![]
                    };
                    Ok(RegistrySnapshot { entries, processes })
                });
                if run(ROOT.into(), read, s, r, sink.clone()).is_err() {
                    sink(Err("Mic/camera activity is unavailable.".into()))
                }
            })
            .map_err(|_| "Privacy watcher unavailable")?;
        *state = Some(Worker {
            stop,
            refresh,
            join,
        });
        Ok(())
    }
    fn resume(&self) {
        if let Some(w) = self.worker.lock().unwrap().as_ref() {
            unsafe { SetEvent(w.refresh.as_raw_handle()) };
        }
    }
    fn stop(&self) {
        if let Some(w) = self.worker.lock().unwrap().take() {
            unsafe { SetEvent(w.stop.as_raw_handle()) };
            let _ = w.join.join();
        }
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.stop();
    }
}
#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
