use super::*;
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::HWND,
        System::Power::{
            GetSystemPowerStatus, RegisterPowerSettingNotification,
            UnregisterPowerSettingNotification, SYSTEM_POWER_STATUS,
        },
        UI::WindowsAndMessaging::DEVICE_NOTIFY_WINDOW_HANDLE,
    },
};
pub struct SystemProvider;
impl PowerProvider for SystemProvider {
    fn sample(&self) -> Result<RawStatus, String> {
        let mut status: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
            return Err("Battery status is unavailable.".into());
        }
        Ok(RawStatus {
            ac_line_status: status.ACLineStatus,
            battery_flag: status.BatteryFlag,
            battery_life_percent: status.BatteryLifePercent,
        })
    }
}
const SOURCE: GUID = GUID::from_u128(0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548);
const PERCENT: GUID = GUID::from_u128(0xa7ad8041_b45a_4cae_87a3_eecbb468a9e1);
pub struct Registration(Vec<usize>);
impl Registration {
    pub fn new(hwnd: HWND) -> Result<Self, String> {
        let mut registration = Self(vec![]);
        for guid in [SOURCE, PERCENT] {
            let handle = unsafe {
                RegisterPowerSettingNotification(hwnd, &guid, DEVICE_NOTIFY_WINDOW_HANDLE)
            };
            if handle == 0 {
                return Err("Power notifications are unavailable.".into());
            }
            registration.0.push(handle as usize);
        }
        Ok(registration)
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        for handle in self.0.drain(..) {
            unsafe { UnregisterPowerSettingNotification(handle as _) };
        }
    }
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Header {
    setting: GUID,
    length: u32,
}
/// Called only with an OS-owned WM_POWERBROADCAST payload (or an owned test buffer).
/// # Safety
/// For PBT_POWERSETTINGCHANGE, nonzero `l` must point to a readable notification header.
pub unsafe fn relevant(w: usize, l: isize) -> bool {
    match w {
        10 | 18 => true,
        0x8013 if l != 0 => {
            let header = unsafe { std::ptr::read_unaligned(l as *const Header) };
            header.length == 4
                && [SOURCE, PERCENT].iter().any(|g| {
                    g.data1 == header.setting.data1
                        && g.data2 == header.setting.data2
                        && g.data3 == header.setting.data3
                        && g.data4 == header.setting.data4
                })
        }
        _ => false,
    }
}
/// # Safety
/// The payload must meet the same readable-header requirement as `relevant`.
pub unsafe fn notify(app: &tauri::AppHandle, w: usize, l: isize) {
    if unsafe { relevant(w, l) } {
        app.state::<Arc<Service>>().refresh();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notification_payloads_are_filtered_without_reading_or_changing_power() {
        assert!(unsafe { relevant(10, 0) });
        assert!(unsafe { relevant(18, 0) });
        assert!(!unsafe { relevant(0x8013, 0) });
        for setting in [SOURCE, PERCENT] {
            let mut header = Header { setting, length: 4 };
            assert!(unsafe { relevant(0x8013, (&header as *const Header) as isize) });
            header.length = 0;
            assert!(!unsafe { relevant(0x8013, (&header as *const Header) as isize) });
        }
        let header = Header {
            setting: GUID::from_u128(1),
            length: 4,
        };
        assert!(!unsafe { relevant(0x8013, (&header as *const Header) as isize) });
        assert!(!unsafe { relevant(4, 0) });
    }
    #[test]
    fn owned_hidden_window_registers_and_unregisters_both_settings() {
        use windows_sys::{core::w, Win32::UI::WindowsAndMessaging::*};
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!("Nabbit owned power test"),
                WS_POPUP,
                0,
                0,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null());
        let registration = Registration::new(hwnd).unwrap();
        assert_eq!(registration.0.len(), 2);
        drop(registration);
        assert_ne!(unsafe { DestroyWindow(hwnd) }, 0);
    }
}
