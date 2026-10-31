//! Windows: is a YubiKey plugged in, and notify when that changes (ARCHITECTURE §8.5).
//!
//! Uses the Configuration Manager (cfgmgr32): it lists present HID device interfaces
//! and registers for HID interface arrival/removal. No device is opened, so this
//! works without admin rights, even though Windows blocks raw FIDO HID access.

use core::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use windows::Win32::Devices::DeviceAndDriverInstallation::{
    CM_GET_DEVICE_INTERFACE_LIST_PRESENT, CM_Get_Device_Interface_List_SizeW,
    CM_Get_Device_Interface_ListW, CM_NOTIFY_ACTION, CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL,
    CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL, CM_NOTIFY_EVENT_DATA, CM_NOTIFY_FILTER,
    CM_NOTIFY_FILTER_0, CM_NOTIFY_FILTER_0_0, CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
    CM_Register_Notification, CM_Unregister_Notification, CR_BUFFER_SMALL, CR_SUCCESS,
    HCMNOTIFICATION,
};
use windows::Win32::Devices::HumanInterfaceDevice::GUID_DEVINTERFACE_HID;
use windows::core::PCWSTR;

use crate::AuthnError;
use crate::presence::any_yubico_in_multi_sz;

/// True if at least one Yubico HID interface is present right now.
pub fn yubikey_present() -> Result<bool, AuthnError> {
    // The list can grow between the size query and the read; retry on CR_BUFFER_SMALL.
    for _ in 0..8 {
        let mut len: u32 = 0;
        // SAFETY: `len` is a valid out pointer and the class GUID is a static; a null
        // device id means "all devices".
        let cr = unsafe {
            CM_Get_Device_Interface_List_SizeW(
                &mut len,
                &GUID_DEVINTERFACE_HID,
                PCWSTR::null(),
                CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
            )
        };
        if cr != CR_SUCCESS {
            return Err(AuthnError::Platform(cr.0));
        }
        let mut list = vec![0u16; len as usize];
        // SAFETY: `list` is a writable buffer; the binding passes its exact length.
        let cr = unsafe {
            CM_Get_Device_Interface_ListW(
                &GUID_DEVINTERFACE_HID,
                PCWSTR::null(),
                &mut list,
                CM_GET_DEVICE_INTERFACE_LIST_PRESENT,
            )
        };
        if cr == CR_BUFFER_SMALL {
            continue;
        }
        if cr != CR_SUCCESS {
            return Err(AuthnError::Platform(cr.0));
        }
        return Ok(any_yubico_in_multi_sz(&list));
    }
    Err(AuthnError::Platform(CR_BUFFER_SMALL.0))
}

struct Shared {
    /// Last state reported to `on_change`.
    present: AtomicBool,
    /// Serialises re-enumeration so transitions are reported in order.
    refresh_lock: Mutex<()>,
    on_change: Box<dyn Fn(bool) + Send + Sync>,
}

impl Shared {
    fn refresh(&self) {
        let _guard = self
            .refresh_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Fail safe: if enumeration fails, report "no YubiKey", so the vault locks.
        let now = yubikey_present().unwrap_or(false);
        if self.present.swap(now, Ordering::SeqCst) != now {
            (self.on_change)(now);
        }
    }
}

/// Calls `on_change(present)` whenever "is any YubiKey plugged in" changes.
///
/// # Threading
/// `on_change` runs on a Windows thread-pool thread, inside the cfgmgr32 notification
/// callback. Keep it short (e.g. send a message to the app's event loop). It must not
/// drop the `PresenceWatcher`: unregistering waits for running callbacks and would
/// deadlock.
pub struct PresenceWatcher {
    handle: HCMNOTIFICATION,
    shared: Arc<Shared>,
}

// SAFETY: HCMNOTIFICATION is an opaque registration handle that cfgmgr32 allows to be
// unregistered from any thread; `Shared` is Send + Sync.
unsafe impl Send for PresenceWatcher {}

impl PresenceWatcher {
    /// Starts watching. The current state is available from [`Self::is_present`];
    /// `on_change` is only called for later changes.
    pub fn start(on_change: impl Fn(bool) + Send + Sync + 'static) -> Result<Self, AuthnError> {
        let shared = Arc::new(Shared {
            present: AtomicBool::new(yubikey_present()?),
            refresh_lock: Mutex::new(()),
            on_change: Box::new(on_change),
        });
        let filter = CM_NOTIFY_FILTER {
            cbSize: size_of::<CM_NOTIFY_FILTER>() as u32,
            Flags: 0,
            FilterType: CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
            Reserved: 0,
            u: CM_NOTIFY_FILTER_0 {
                DeviceInterface: CM_NOTIFY_FILTER_0_0 {
                    ClassGuid: GUID_DEVINTERFACE_HID,
                },
            },
        };
        let mut handle = HCMNOTIFICATION(core::ptr::null_mut());
        let context: *const c_void = Arc::as_ptr(&shared).cast();
        // SAFETY: `filter` and `handle` are valid for the call. `context` points to
        // `Shared`, which the returned watcher keeps alive until after
        // CM_Unregister_Notification has returned (see Drop), so the callback never
        // sees a dangling pointer.
        let cr = unsafe {
            CM_Register_Notification(&filter, Some(context), Some(on_notify), &mut handle)
        };
        if cr != CR_SUCCESS {
            return Err(AuthnError::Platform(cr.0));
        }
        let watcher = Self { handle, shared };
        // A change between the first enumeration and the registration would otherwise
        // go unnoticed.
        watcher.shared.refresh();
        Ok(watcher)
    }

    /// Whether a YubiKey was present at the last check.
    pub fn is_present(&self) -> bool {
        self.shared.present.load(Ordering::SeqCst)
    }
}

impl Drop for PresenceWatcher {
    fn drop(&mut self) {
        // SAFETY: `handle` came from a successful CM_Register_Notification and is
        // unregistered exactly once. The call waits for in-flight callbacks, after
        // which `shared` (dropped after this) is no longer referenced by Windows.
        let _ = unsafe { CM_Unregister_Notification(self.handle) };
    }
}

/// cfgmgr32 notification callback (runs on a thread-pool thread).
unsafe extern "system" fn on_notify(
    _handle: HCMNOTIFICATION,
    context: *const c_void,
    action: CM_NOTIFY_ACTION,
    _event_data: *const CM_NOTIFY_EVENT_DATA,
    _event_data_size: u32,
) -> u32 {
    if (action == CM_NOTIFY_ACTION_DEVICEINTERFACEARRIVAL
        || action == CM_NOTIFY_ACTION_DEVICEINTERFACEREMOVAL)
        && !context.is_null()
    {
        // SAFETY: `context` is `Arc::as_ptr` of the `Shared` owned by the registering
        // `PresenceWatcher`, alive until its registration is removed (see Drop).
        let shared = unsafe { &*context.cast::<Shared>() };
        shared.refresh();
    }
    0 // ERROR_SUCCESS
}
