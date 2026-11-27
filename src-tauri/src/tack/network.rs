//! Windows connectivity events. No connectivity polling or probe traffic.
use super::service::Service;
use std::{
    ffi::c_void,
    sync::atomic::{AtomicBool, Ordering},
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    NetworkManagement::IpHelper::{CancelMibChangeNotify2, NotifyNetworkConnectivityHintChange},
    Networking::WinSock::{
        NetworkConnectivityLevelHintInternetAccess, NL_NETWORK_CONNECTIVITY_HINT,
    },
};
struct Callback {
    service: Service,
    online: AtomicBool,
}
unsafe extern "system" fn changed(context: *const c_void, hint: NL_NETWORK_CONNECTIVITY_HINT) {
    let Some(context) = (unsafe { (context as *const Callback).as_ref() }) else {
        return;
    };
    let online = hint.ConnectivityLevel == NetworkConnectivityLevelHintInternetAccess;
    let previous = context.online.swap(online, Ordering::AcqRel);
    if online && !previous {
        context.service.network_regained();
    }
}
pub(crate) struct Watch {
    handle: HANDLE,
    context: Box<Callback>,
}
impl Watch {
    fn cancel(&mut self) -> std::result::Result<(), u32> {
        if self.handle.is_null() {
            return Ok(());
        }
        let result = unsafe { CancelMibChangeNotify2(self.handle) };
        if result == 0 {
            self.handle = std::ptr::null_mut();
            Ok(())
        } else {
            Err(result)
        }
    }
    pub fn start(service: Service) -> std::result::Result<Self, u32> {
        let context = Box::new(Callback {
            service,
            online: AtomicBool::new(false),
        });
        let mut handle = std::ptr::null_mut();
        let result = unsafe {
            NotifyNetworkConnectivityHintChange(
                Some(changed),
                (&*context as *const Callback).cast(),
                1,
                &mut handle,
            )
        };
        if result != 0 {
            return Err(result);
        }
        Ok(Self { handle, context })
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        // This guard is dropped by the worker, never from the callback or while a
        // controller lock is held. Cancellation waits for in-flight callbacks.
        if self.cancel().is_err() {
            // A failed cancellation must not free a callback target still owned by
            // Windows. Keep only this small target alive until process exit.
            let replacement = Box::new(Callback {
                service: Service::default(),
                online: AtomicBool::new(false),
            });
            let target = std::mem::replace(&mut self.context, replacement);
            let _ = Box::leak(target);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_connectivity_registration_and_cancellation_need_no_network_changes() {
        let mut watch = Watch::start(Service::default()).expect("native connectivity registration");
        assert!(!watch.handle.is_null());
        watch.cancel().expect("native connectivity cancellation");
        assert!(watch.handle.is_null());
        drop(watch);
    }
}
