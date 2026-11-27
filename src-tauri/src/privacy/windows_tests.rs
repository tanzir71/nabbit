use super::*;
use std::{
    os::windows::process::CommandExt,
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc,
    },
    time::Duration,
};
struct Fixture {
    path: String,
    key: Key,
}
impl Fixture {
    fn new() -> Self {
        let path = format!("Software\\Nabbit\\Tests\\Privacy\\{}", uuid::Uuid::new_v4());
        Self {
            key: create(HKEY_CURRENT_USER, &path),
            path,
        }
    }
    fn usage(&self, capability: &str, image: &str) -> Key {
        create(
            self.key.0,
            &format!("{capability}\\NonPackaged\\{}", image.replace('\\', "#")),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(&self.path).as_ptr()) };
    }
}
fn create(parent: HKEY, path: &str) -> Key {
    let mut key = ptr::null_mut();
    assert_eq!(
        unsafe {
            RegCreateKeyExW(
                parent,
                wide(path).as_ptr(),
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
    Key(key)
}
fn qword(key: &Key, name: &str, value: u64) {
    assert_eq!(
        unsafe {
            RegSetValueExW(
                key.0,
                wide(name).as_ptr(),
                0,
                REG_QWORD,
                (&value as *const u64).cast(),
                8,
            )
        },
        ERROR_SUCCESS
    );
}
struct Running {
    stop: Arc<OwnedHandle>,
    refresh: Arc<OwnedHandle>,
    join: Option<JoinHandle<io::Result<()>>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        unsafe { SetEvent(self.stop.as_raw_handle()) };
        assert!(self.join.take().unwrap().join().unwrap().is_ok());
    }
}
fn next(
    rx: &mpsc::Receiver<model::Active>,
    predicate: impl Fn(&model::Active) -> bool,
) -> model::Active {
    for _ in 0..20 {
        let v = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        if predicate(&v) {
            return v;
        }
    }
    panic!("No matching owned registry state")
}
#[test]
fn native_registry_subtree_notifications_rearm_and_idle_without_reads() {
    let fixture = Fixture::new();
    let root = fixture.path.clone();
    let image = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let stop = Arc::new(event().unwrap());
    let refresh = Arc::new(event().unwrap());
    let reads = Arc::new(AtomicU32::new(0));
    let count = reads.clone();
    let (tx, rx) = mpsc::channel();
    let read_root = root.clone();
    let read: Read = Box::new(move || {
        count.fetch_add(1, Ordering::SeqCst);
        let entries = entries(&read_root)?;
        let processes = process(std::process::id(), &entries).into_iter().collect();
        Ok(RegistrySnapshot { entries, processes })
    });
    let s = stop.clone();
    let r = refresh.clone();
    let join = std::thread::spawn(move || {
        run(
            root,
            read,
            s,
            r,
            Arc::new(move |v| {
                tx.send(model::resolve(&v.unwrap())).unwrap();
            }),
        )
    });
    let running = Running {
        stop,
        refresh,
        join: Some(join),
    };
    assert_eq!(next(&rx, |_| true), model::Active::default());
    {
        let mic = fixture.usage("microphone", &image);
        qword(&mic, "LastUsedTimeStart", u64::MAX - 1);
        qword(&mic, "LastUsedTimeStop", 0);
    }
    let active = next(&rx, |a| !a.mic.is_empty());
    assert_eq!(active.pids, [std::process::id()]);
    // A newly created subtree and an existing-value mutation both notify.
    {
        let camera = fixture.usage("webcam", &image);
        qword(&camera, "LastUsedTimeStart", u64::MAX - 1);
        qword(&camera, "LastUsedTimeStop", 0);
    }
    next(&rx, |a| !a.camera.is_empty() && !a.mic.is_empty());
    {
        let mic = fixture.usage("microphone", &image);
        qword(&mic, "LastUsedTimeStop", 20);
    }
    next(&rx, |a| a.mic.is_empty() && !a.camera.is_empty());
    unsafe { RegDeleteTreeW(fixture.key.0, w!("webcam")) };
    next(&rx, |a| a.camera.is_empty());
    std::thread::sleep(Duration::from_millis(60));
    let before = reads.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        reads.load(Ordering::SeqCst),
        before,
        "Idle has no timer/read polling"
    );
    // Drain already-delivered change snapshots before observing the explicit wake.
    for _ in rx.try_iter() {}
    unsafe { SetEvent(running.refresh.as_raw_handle()) };
    next(&rx, |_| true);
    assert!(reads.load(Ordering::SeqCst) > before);
    drop(running);
}
#[test]
fn native_timestamp_type_and_deleted_root_are_safe() {
    let fixture = Fixture::new();
    let key = fixture.usage("microphone", "C:\\Fixture\\Host.exe");
    let value = 0u32;
    assert_eq!(
        unsafe {
            RegSetValueExW(
                key.0,
                w!("LastUsedTimeStop"),
                0,
                REG_DWORD,
                (&value as *const u32).cast(),
                4,
            )
        },
        ERROR_SUCCESS
    );
    assert_eq!(key.qword("LastUsedTimeStop"), None);
    qword(&key, "LastUsedTimeStop", 0);
    assert_eq!(key.qword("LastUsedTimeStop"), Some(0));
    drop(key);
    assert_eq!(
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, wide(&fixture.path).as_ptr()) },
        ERROR_SUCCESS
    );
    assert!(entries(&fixture.path).unwrap().is_empty());
    assert!(watch_root(&fixture.path).is_ok());
}
#[test]
fn process_exit_wait_clears_crash_without_registry_write_and_rejects_pid_reuse() {
    let exe = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = std::process::Command::new(&exe)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .creation_flags(0x08000000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    struct Child<'a>(&'a mut std::process::Child);
    impl Drop for Child<'_> {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let child = Child(&mut child);
    let usage = Usage {
        capability: Capability::Microphone,
        key: format!(
            "NonPackaged\\{}",
            exe.to_string_lossy().replace(['\\', '/'], "#")
        ),
        last_used_time_start: Some(u64::MAX - 1),
        last_used_time_stop: Some(0),
    };
    let mut p = process(child.0.id(), std::slice::from_ref(&usage)).unwrap();
    let wake = Arc::new(event().unwrap());
    p.created_at += 1;
    assert!(ExitWait::new(&p, wake.clone()).is_err());
    p.created_at -= 1;
    let wait = ExitWait::new(&p, wake.clone()).unwrap();
    child.0.kill().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(wake.as_raw_handle(), 3000) },
        WAIT_OBJECT_0
    );
    drop(wait);
    assert!(process(child.0.id(), &[usage]).is_none());
}
