//! Read-only Win32 foreground provider. No window titles, executable paths or user content.
use super::{model::Rect, visibility::Foreground};
use windows_sys::Win32::{
    Foundation::RECT,
    Graphics::{Dwm::*, Gdi::*},
    UI::{Shell::SHQueryUserNotificationState, WindowsAndMessaging::*},
};
pub fn read() -> Foreground {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return Foreground::default();
        }
        let mut process = 0;
        GetWindowThreadProcessId(window, &mut process);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of_val(&info) as u32;
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let rectangle = |rect: RECT| Rect {
            x: rect.left,
            y: rect.top,
            width: rect.right.saturating_sub(rect.left).max(0) as u32,
            height: rect.bottom.saturating_sub(rect.top).max(0) as u32,
        };
        let monitor = if GetMonitorInfoW(monitor, &mut info) != 0 {
            Some(rectangle(info.rcMonitor))
        } else {
            None
        };
        let mut rect: RECT = std::mem::zeroed();
        let mut got = DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut rect as *mut _ as *mut _,
            std::mem::size_of_val(&rect) as u32,
        ) >= 0;
        if !got {
            got = GetWindowRect(window, &mut rect) != 0;
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut _ as *mut _,
            4,
        );
        let mut name = [0u16; 128];
        let length = GetClassNameW(window, name.as_mut_ptr(), name.len() as i32).max(0) as usize;
        let class = String::from_utf16_lossy(&name[..length]);
        let mut notification = 0;
        let notification_state =
            (SHQueryUserNotificationState(&mut notification) >= 0).then_some(notification);
        let result = Foreground {
            window_id: window as u64,
            rect: got.then(|| rectangle(rect)),
            monitor,
            maximised: IsZoomed(window) != 0,
            minimised: IsIconic(window) != 0,
            visible: IsWindowVisible(window) != 0,
            cloaked: cloaked != 0,
            own_process: process == std::process::id(),
            desktop: matches!(
                class.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            ),
            notification_state,
        };
        // A focus change during the read must not suppress the wrong monitor.
        if GetForegroundWindow() != window {
            Foreground::default()
        } else {
            result
        }
    }
}
