//! One message-pumped apartment for Shell COM tasks, dialogs and owned OLE targets.
use crate::error::{msg, Result};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
type Work = Box<dyn FnOnce() + Send>;
struct Wake {
    #[cfg(windows)]
    handle: isize,
}
impl Wake {
    fn new() -> Result<Self> {
        #[cfg(windows)]
        unsafe {
            let handle = windows_sys::Win32::System::Threading::CreateEventW(
                std::ptr::null(),
                0,
                0,
                std::ptr::null(),
            );
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self {
                handle: handle as isize,
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {})
        }
    }
    fn signal(&self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::Threading::SetEvent(self.handle as _);
        }
    }
}
impl Drop for Wake {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}
struct Worker {
    sender: mpsc::Sender<Option<Work>>,
    wake: Arc<Wake>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}
static WORKER: OnceLock<std::result::Result<Worker, String>> = OnceLock::new();
thread_local! {static CURRENT:std::cell::Cell<bool>=const{std::cell::Cell::new(false)};}
#[cfg(windows)]
fn receive(receiver: mpsc::Receiver<Option<Work>>, wake: Arc<Wake>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    'worker: loop {
        loop {
            match receiver.try_recv() {
                Ok(Some(work)) => work(),
                Ok(None) | Err(mpsc::TryRecvError::Disconnected) => break 'worker,
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let handle = wake.handle as windows_sys::Win32::Foundation::HANDLE;
            MsgWaitForMultipleObjectsEx(1, &handle, u32::MAX, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }
    }
}
#[cfg(not(windows))]
fn receive(receiver: mpsc::Receiver<Option<Work>>, _wake: Arc<Wake>) {
    while let Ok(Some(work)) = receiver.recv() {
        work();
    }
}
pub fn run<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    if CURRENT.with(|current| current.get()) {
        return work();
    }
    let worker = WORKER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::channel::<Option<Work>>();
            let (ready, initialized) = mpsc::sync_channel(1);
            let wake = Arc::new(Wake::new().map_err(|e| e.to_string())?);
            let wake_thread = wake.clone();
            let thread = std::thread::Builder::new()
                .name("nabbit-shell-sta".into())
                .spawn(move || {
                    #[cfg(windows)]
                    let init = unsafe { windows::Win32::System::Ole::OleInitialize(None) }
                        .map_err(|e| e.to_string());
                    #[cfg(not(windows))]
                    let init: std::result::Result<(), String> = Ok(());
                    let success = init.is_ok();
                    let _ = ready.send(init);
                    if !success {
                        return;
                    }
                    CURRENT.with(|current| current.set(true));
                    receive(receiver, wake_thread);
                    #[cfg(windows)]
                    unsafe {
                        windows::Win32::System::Ole::OleUninitialize();
                    }
                })
                .map_err(|e| e.to_string())?;
            initialized.recv().map_err(|e| e.to_string())??;
            Ok(Worker {
                sender,
                wake,
                thread: Mutex::new(Some(thread)),
            })
        })
        .as_ref()
        .map_err(msg)?;
    let (sender, receiver) = mpsc::sync_channel(1);
    worker
        .sender
        .send(Some(Box::new(move || {
            let _ = sender.send(work());
        })))
        .map_err(|_| msg("Windows file services stopped"))?;
    worker.wake.signal();
    receiver
        .recv()
        .map_err(|_| msg("Windows file task stopped"))?
}
pub fn stop() {
    if let Some(Ok(worker)) = WORKER.get() {
        let _ = worker.sender.send(None);
        worker.wake.signal();
        if let Ok(mut thread) = worker.thread.lock() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
    }
}
