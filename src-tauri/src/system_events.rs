//! Lock triggers from Windows: sleep and hibernate, locking the session, switching user and
//! signing out (ARCHITECTURE §8.5).
//!
//! - **Suspend.** `PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK, …)`. Windows
//!   calls back on one of its own threads with `PBT_APMSUSPEND` before the computer sleeps or
//!   hibernates, and allows about two seconds for it. `on_event` runs inside that callback,
//!   so a lock it does synchronously finishes before RAM is written to `hiberfil.sys`.
//! - **Session changes.** `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)`
//!   sends `WM_WTSSESSION_CHANGE` to a hidden window, which a dedicated thread owns and pumps.
//!   The mapping is:
//!   - `WTS_SESSION_LOCK` → [`SystemEvent::SessionLocked`];
//!   - `WTS_CONSOLE_DISCONNECT` and `WTS_REMOTE_DISCONNECT` (switching user, or a Remote
//!     Desktop connection ending) → [`SystemEvent::SessionDisconnected`];
//!   - `WTS_SESSION_LOGOFF` → [`SystemEvent::LoggingOff`].
//!
//! The hidden window is a top-level window that is never shown, not a message-only window
//! (`HWND_MESSAGE`). Microsoft documents two things: message-only windows "do not receive
//! broadcast messages", and session notifications are "sent only to the windows that have
//! registered for them". It never says message-only windows are supported, so efre does not
//! depend on it.
//!
//! Other programs can find a top-level window, so this one ignores `WM_CLOSE` and stray
//! `WM_QUIT` messages. Only dropping [`SystemEvents`] stops it.
//!
//! `on_event` must be quick and must not drop the [`SystemEvents`] guard. It runs on a
//! Windows thread (suspend) or on the window thread (session changes), possibly on both at
//! once. A panic in it aborts the process, because the callbacks cannot unwind into
//! Windows; the vault is then gone with the process, which is the safe outcome.
//!
//! On other platforms (development only), [`watch`] returns a guard that does nothing.

/// A reason to lock the vault, reported by Windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SystemEvent {
    /// The computer is about to sleep or hibernate.
    Suspend,
    /// The session was locked: Win+L, or a screen saver that locks.
    SessionLocked,
    /// The session left its screen: another user switched in, or a Remote Desktop
    /// connection ended.
    SessionDisconnected,
    /// The user is signing out.
    LoggingOff,
}

#[cfg(windows)]
pub(crate) use imp::SystemEvents;

/// Stands in for the Windows watcher on other platforms. Dropping it does nothing.
#[cfg(not(windows))]
pub(crate) struct SystemEvents(());

/// Calls `on_event` for every lock trigger until the returned guard is dropped.
///
/// # Errors
/// A description of the Windows call that failed. It never contains secret data.
#[cfg(windows)]
pub(crate) fn watch(
    on_event: impl Fn(SystemEvent) + Send + Sync + 'static,
) -> Result<SystemEvents, String> {
    imp::watch(Box::new(on_event))
}

/// Development platforms: there is nothing to watch, so this returns a guard that does
/// nothing and never calls `on_event`.
#[cfg(not(windows))]
pub(crate) fn watch(
    _on_event: impl Fn(SystemEvent) + Send + Sync + 'static,
) -> Result<SystemEvents, String> {
    Ok(SystemEvents(()))
}

// Win32 values (WinUser.h). On Windows a compile-time check compares them with the bindings.
const PBT_APMSUSPEND: u32 = 0x4;
const WTS_CONSOLE_DISCONNECT: u32 = 0x2;
const WTS_REMOTE_DISCONNECT: u32 = 0x4;
const WTS_SESSION_LOGOFF: u32 = 0x6;
const WTS_SESSION_LOCK: u32 = 0x7;

/// The lock trigger for a suspend/resume notification type, if any.
#[cfg_attr(not(windows), allow(dead_code))]
fn power_event(kind: u32) -> Option<SystemEvent> {
    (kind == PBT_APMSUSPEND).then_some(SystemEvent::Suspend)
}

/// The lock trigger for the `wParam` of `WM_WTSSESSION_CHANGE`, if any.
#[cfg_attr(not(windows), allow(dead_code))]
fn session_event(code: u32) -> Option<SystemEvent> {
    match code {
        WTS_SESSION_LOCK => Some(SystemEvent::SessionLocked),
        WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT => Some(SystemEvent::SessionDisconnected),
        WTS_SESSION_LOGOFF => Some(SystemEvent::LoggingOff),
        _ => None,
    }
}

#[cfg(windows)]
mod imp {
    use core::ffi::c_void;
    use core::ptr;
    use std::cell::OnceCell;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use windows::Win32::Foundation::{
        ERROR_SUCCESS, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::{
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY, PowerRegisterSuspendResumeNotification,
        PowerUnregisterSuspendResumeNotification,
    };
    use windows::Win32::System::RemoteDesktop::{
        NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DEVICE_NOTIFY_CALLBACK, DefWindowProcW, DestroyWindow, DispatchMessageW,
        GetMessageW, MSG, PostMessageW, RegisterClassExW, UnregisterClassW, WM_APP, WM_CLOSE,
        WM_WTSSESSION_CHANGE, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    };
    use windows::core::{Error, HRESULT, PCWSTR, w};

    use super::{SystemEvent, power_event, session_event};

    // The portable constants in the parent module must match the Windows headers.
    const _: () = {
        use windows::Win32::UI::WindowsAndMessaging as wm;
        assert!(super::PBT_APMSUSPEND == wm::PBT_APMSUSPEND);
        assert!(super::WTS_CONSOLE_DISCONNECT == wm::WTS_CONSOLE_DISCONNECT);
        assert!(super::WTS_REMOTE_DISCONNECT == wm::WTS_REMOTE_DISCONNECT);
        assert!(super::WTS_SESSION_LOGOFF == wm::WTS_SESSION_LOGOFF);
        assert!(super::WTS_SESSION_LOCK == wm::WTS_SESSION_LOCK);
    };

    /// Wakes the window thread so that it notices `Shared::stopping`.
    const WM_EFRE_STOP: u32 = WM_APP + 1;
    /// `HRESULT_FROM_WIN32(RPC_S_INVALID_BINDING)`. Microsoft documents that
    /// `WTSRegisterSessionNotification` returns this until Remote Desktop Services has
    /// started.
    const RPC_S_INVALID_BINDING: HRESULT = HRESULT::from_win32(1702);
    const SESSION_ATTEMPTS: u32 = 20;
    const SESSION_RETRY: Duration = Duration::from_millis(250);

    struct Shared {
        on_event: Box<dyn Fn(SystemEvent) + Send + Sync>,
        /// Set by `SystemEvents::drop`. The window thread stops only once this is set.
        stopping: AtomicBool,
    }

    /// Live watchers by id. The power callback's context is the id, not a pointer, so a
    /// callback that arrives after unregistering finds nothing instead of freed memory.
    static WATCHERS: Mutex<Vec<(usize, Arc<Shared>)>> = Mutex::new(Vec::new());
    static NEXT_ID: AtomicUsize = AtomicUsize::new(1);

    fn watchers() -> MutexGuard<'static, Vec<(usize, Arc<Shared>)>> {
        WATCHERS.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn lookup(id: usize) -> Option<Arc<Shared>> {
        watchers()
            .iter()
            .find(|(watcher, _)| *watcher == id)
            .map(|(_, shared)| Arc::clone(shared))
    }

    thread_local! {
        /// The watcher whose hidden window this thread owns. Read by `window_proc`.
        static WINDOW_OWNER: OnceCell<Arc<Shared>> = const { OnceCell::new() };
    }

    /// Watches for lock triggers until dropped. Dropping it ends the message loop,
    /// unregisters both notifications, destroys the window and joins its thread.
    pub(crate) struct SystemEvents {
        shared: Arc<Shared>,
        /// The hidden window, stored as an address. A window handle is an opaque value that
        /// Rust never dereferences, and as an integer it keeps this type `Send` and `Sync`.
        hwnd: usize,
        thread: Option<JoinHandle<()>>,
    }

    pub(super) fn watch(
        on_event: Box<dyn Fn(SystemEvent) + Send + Sync>,
    ) -> Result<SystemEvents, String> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let shared = Arc::new(Shared {
            on_event,
            stopping: AtomicBool::new(false),
        });
        let (ready, started) = mpsc::sync_channel(1);
        let thread = {
            let shared = Arc::clone(&shared);
            thread::Builder::new()
                .name("efre-system-events".into())
                .spawn(move || run(id, shared, ready))
                .map_err(|error| format!("could not start the system-event thread: {error}"))?
        };
        match started.recv() {
            Ok(Ok(hwnd)) => Ok(SystemEvents {
                shared,
                hwnd,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err("the system-event thread stopped during setup".to_owned())
            }
        }
    }

    impl Drop for SystemEvents {
        fn drop(&mut self) {
            self.shared.stopping.store(true, Ordering::SeqCst);
            let hwnd = HWND(ptr::without_provenance_mut(self.hwnd));
            // SAFETY: posting a message has no memory-safety requirements. If the window is
            // already gone, the call just fails.
            let posted = unsafe { PostMessageW(Some(hwnd), WM_EFRE_STOP, WPARAM(0), LPARAM(0)) };
            let Some(thread) = self.thread.take() else {
                return;
            };
            // Joining from the window thread itself (`on_event` dropped the guard) would
            // deadlock; its loop ends right after `on_event` returns. Without the wake-up
            // message the thread would never notice `stopping`, so joining would hang.
            if posted.is_ok() && thread.thread().id() != thread::current().id() {
                let _ = thread.join();
            }
        }
    }

    /// Body of the window thread.
    fn run(id: usize, shared: Arc<Shared>, ready: mpsc::SyncSender<Result<usize, String>>) {
        let _ = WINDOW_OWNER.try_with(|owner| owner.set(Arc::clone(&shared)));
        let registrations = match Registrations::new(id, &shared) {
            Ok(registrations) => registrations,
            Err(error) => {
                let _ = ready.send(Err(error));
                return;
            }
        };
        let _ = ready.send(Ok(registrations.hwnd_address()));
        pump(&shared);
        drop(registrations);
    }

    /// The window thread's message loop. It ends only after `SystemEvents::drop` has set
    /// `stopping`.
    fn pump(shared: &Shared) {
        let mut message = MSG::default();
        loop {
            // SAFETY: `message` is a valid out buffer. No window filter means every message
            // for this thread.
            let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
            match result.0 {
                // Only invalid arguments make GetMessageW fail; this thread can do no more.
                -1 => return,
                // WM_QUIT. Another program can post one to a top-level window: ignore it.
                0 => {}
                _ => {
                    // SAFETY: `message` was just filled in by GetMessageW.
                    unsafe { DispatchMessageW(&message) };
                }
            }
            if shared.stopping.load(Ordering::SeqCst) {
                return;
            }
        }
    }

    /// The hidden window's procedure. Runs on the window thread.
    extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_WTSSESSION_CHANGE => {
                if let Some(event) = u32::try_from(wparam.0).ok().and_then(session_event) {
                    let _ = WINDOW_OWNER.try_with(|owner| {
                        if let Some(shared) = owner.get() {
                            (shared.on_event)(event);
                        }
                    });
                }
                LRESULT(0)
            }
            // Other programs can find a top-level window and ask it to close. Only
            // `SystemEvents::drop` may stop this one.
            WM_CLOSE => LRESULT(0),
            // SAFETY: forwards the message Windows passed in, unchanged.
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    /// The suspend/resume callback. Windows calls it on one of its own threads. Its context
    /// is the watcher's id.
    extern "system" fn on_power(context: *const c_void, kind: u32, _setting: *const c_void) -> u32 {
        if let Some(event) = power_event(kind)
            && let Some(shared) = lookup(context.addr())
        {
            (shared.on_event)(event);
        }
        ERROR_SUCCESS.0
    }

    /// Everything the window thread sets up. Dropping it releases each piece in reverse
    /// order, on that same thread.
    struct Registrations {
        id: usize,
        instance: HINSTANCE,
        /// NUL-terminated, unique per watcher.
        class_name: Vec<u16>,
        class_registered: bool,
        hwnd: Option<HWND>,
        session_registered: bool,
        listed: bool,
        /// Boxed so it never moves while registered. It must outlive the registration, so
        /// it is a field and is dropped after `Drop::drop` has unregistered.
        power_params: Box<DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS>,
        power: Option<HPOWERNOTIFY>,
    }

    impl Registrations {
        fn new(id: usize, shared: &Arc<Shared>) -> Result<Self, String> {
            // SAFETY: a null name asks for the running executable's handle, which needs no
            // cleanup.
            let module = unsafe { GetModuleHandleW(PCWSTR::null()) }
                .map_err(|error| format!("GetModuleHandleW failed: {error}"))?;
            // Each early return below drops `this`, which undoes the steps already done.
            let mut this = Self {
                id,
                instance: HINSTANCE::from(module),
                class_name: format!("efre-system-events-{id}")
                    .encode_utf16()
                    .chain([0])
                    .collect(),
                class_registered: false,
                hwnd: None,
                session_registered: false,
                listed: false,
                power_params: Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
                    Callback: Some(on_power),
                    Context: ptr::without_provenance_mut(id),
                }),
                power: None,
            };

            let class = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(window_proc),
                hInstance: this.instance,
                lpszClassName: PCWSTR(this.class_name.as_ptr()),
                ..Default::default()
            };
            // SAFETY: `class` is fully initialised, and the name it points to lives in
            // `this` until after `Drop` has unregistered the class.
            let atom = unsafe { RegisterClassExW(&class) };
            if atom == 0 {
                return Err(format!("RegisterClassExW failed: {}", Error::from_thread()));
            }
            this.class_registered = true;

            // SAFETY: this thread registered the class just above, and every pointer is valid
            // for the call. The window is never shown.
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                    PCWSTR(this.class_name.as_ptr()),
                    w!("efre system events"),
                    WS_POPUP,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    Some(this.instance),
                    None,
                )
            }
            .map_err(|error| format!("CreateWindowExW failed: {error}"))?;
            this.hwnd = Some(hwnd);

            register_session(hwnd)?;
            this.session_registered = true;

            watchers().push((id, Arc::clone(shared)));
            this.listed = true;

            let recipient = HANDLE((&raw mut *this.power_params).cast());
            let mut handle: *mut c_void = ptr::null_mut();
            // SAFETY: `recipient` points to the boxed DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS in
            // `this`, which neither moves nor is freed before `Drop` unregisters. `handle` is
            // a valid out pointer. The context is an id that is never dereferenced.
            let status = unsafe {
                PowerRegisterSuspendResumeNotification(
                    DEVICE_NOTIFY_CALLBACK,
                    recipient,
                    &mut handle,
                )
            };
            if status != ERROR_SUCCESS {
                return Err(format!(
                    "PowerRegisterSuspendResumeNotification failed: {}",
                    Error::from_hresult(HRESULT::from_win32(status.0))
                ));
            }
            this.power = Some(HPOWERNOTIFY(handle.addr() as isize));
            Ok(this)
        }

        fn hwnd_address(&self) -> usize {
            self.hwnd.map_or(0, |hwnd| hwnd.0.addr())
        }
    }

    impl Drop for Registrations {
        fn drop(&mut self) {
            if let Some(handle) = self.power.take() {
                // SAFETY: `handle` came from a successful
                // PowerRegisterSuspendResumeNotification and is unregistered exactly once.
                let _ = unsafe { PowerUnregisterSuspendResumeNotification(handle) };
            }
            if self.listed {
                watchers().retain(|(id, _)| *id != self.id);
            }
            if let Some(hwnd) = self.hwnd.take() {
                if self.session_registered {
                    // SAFETY: `hwnd` is this thread's live window, registered once. Microsoft
                    // requires unregistering before the window is destroyed.
                    let _ = unsafe { WTSUnRegisterSessionNotification(hwnd) };
                }
                // SAFETY: this thread created `hwnd`, only the creating thread may destroy a
                // window, and it is destroyed exactly once.
                let _ = unsafe { DestroyWindow(hwnd) };
            }
            if self.class_registered {
                // SAFETY: `class_name` is the NUL-terminated name this thread registered, and
                // the class's only window was destroyed just above.
                let _ = unsafe {
                    UnregisterClassW(PCWSTR(self.class_name.as_ptr()), Some(self.instance))
                };
            }
        }
    }

    fn register_session(hwnd: HWND) -> Result<(), String> {
        let mut attempt = 1;
        loop {
            // SAFETY: `hwnd` is a live window owned by this thread.
            match unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } {
                Ok(()) => return Ok(()),
                Err(error)
                    if error.code() == RPC_S_INVALID_BINDING && attempt < SESSION_ATTEMPTS =>
                {
                    attempt += 1;
                    thread::sleep(SESSION_RETRY);
                }
                Err(error) => {
                    return Err(format!("WTSRegisterSessionNotification failed: {error}"));
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use windows::Win32::UI::WindowsAndMessaging::{
            PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND, SendMessageW, WM_QUIT, WTS_CONSOLE_CONNECT,
            WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT, WTS_SESSION_LOCK, WTS_SESSION_LOGOFF,
            WTS_SESSION_LOGON, WTS_SESSION_UNLOCK,
        };

        use super::SystemEvent::{LoggingOff, SessionDisconnected, SessionLocked, Suspend};
        use super::*;

        type Seen = Arc<Mutex<Vec<SystemEvent>>>;

        fn recording() -> (Seen, SystemEvents) {
            let seen: Seen = Arc::default();
            let sink = Arc::clone(&seen);
            let events = watch(Box::new(move |event| sink.lock().unwrap().push(event))).unwrap();
            (seen, events)
        }

        /// Delivers a session change to the watcher's window, synchronously.
        fn session_change(hwnd: usize, code: u32) {
            let hwnd = HWND(ptr::without_provenance_mut(hwnd));
            // SAFETY: SendMessageW only passes the integers through; the window procedure
            // runs on its own thread before this returns.
            unsafe {
                SendMessageW(
                    hwnd,
                    WM_WTSSESSION_CHANGE,
                    Some(WPARAM(code as usize)),
                    Some(LPARAM(1)),
                )
            };
        }

        fn id_of(events: &SystemEvents) -> usize {
            watchers()
                .iter()
                .find(|(_, shared)| Arc::ptr_eq(shared, &events.shared))
                .map(|(id, _)| *id)
                .unwrap()
        }

        #[test]
        fn delivers_lock_triggers_until_dropped() {
            let (seen, events) = recording();
            for code in [
                WTS_SESSION_LOCK,
                WTS_SESSION_UNLOCK,
                WTS_CONSOLE_DISCONNECT,
                WTS_CONSOLE_CONNECT,
                WTS_REMOTE_DISCONNECT,
                WTS_SESSION_LOGON,
                WTS_SESSION_LOGOFF,
            ] {
                session_change(events.hwnd, code);
            }
            let id = id_of(&events);
            on_power(ptr::without_provenance(id), PBT_APMSUSPEND, ptr::null());
            on_power(
                ptr::without_provenance(id),
                PBT_APMRESUMEAUTOMATIC,
                ptr::null(),
            );
            assert_eq!(
                *seen.lock().unwrap(),
                [
                    SessionLocked,
                    SessionDisconnected,
                    SessionDisconnected,
                    LoggingOff,
                    Suspend
                ]
            );

            drop(events);
            assert!(lookup(id).is_none());
            // A callback that arrives after the guard is gone does nothing.
            on_power(ptr::without_provenance(id), PBT_APMSUSPEND, ptr::null());
            assert_eq!(seen.lock().unwrap().len(), 5);
        }

        #[test]
        fn ignores_close_and_stray_quit() {
            let (seen, events) = recording();
            let hwnd = HWND(ptr::without_provenance_mut(events.hwnd));
            // SAFETY: SendMessageW only passes the integers through.
            unsafe { SendMessageW(hwnd, WM_CLOSE, None, None) };
            // SAFETY: as above, for PostMessageW.
            unsafe { PostMessageW(Some(hwnd), WM_QUIT, WPARAM(0), LPARAM(0)) }.unwrap();
            thread::sleep(Duration::from_millis(100));
            session_change(events.hwnd, WTS_SESSION_LOCK);
            assert_eq!(*seen.lock().unwrap(), [SessionLocked]);
        }

        #[test]
        fn watchers_are_independent() {
            let (seen_a, a) = recording();
            let (seen_b, b) = recording();
            assert_ne!(a.hwnd, b.hwnd);
            session_change(a.hwnd, WTS_SESSION_LOCK);
            drop(a);
            session_change(b.hwnd, WTS_SESSION_LOGOFF);
            assert_eq!(*seen_a.lock().unwrap(), [SessionLocked]);
            assert_eq!(*seen_b.lock().unwrap(), [LoggingOff]);
        }

        #[test]
        fn dropping_the_guard_inside_on_event_does_not_hang() {
            let slot: Arc<Mutex<Option<SystemEvents>>> = Arc::default();
            let in_callback = Arc::clone(&slot);
            let events =
                watch(Box::new(move |_| drop(in_callback.lock().unwrap().take()))).unwrap();
            let hwnd = events.hwnd;
            *slot.lock().unwrap() = Some(events);
            session_change(hwnd, WTS_SESSION_LOCK); // runs on the window thread, drops the guard
            assert!(slot.lock().unwrap().is_none());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_exactly_the_lock_triggers() {
        assert_eq!(power_event(0x4), Some(SystemEvent::Suspend));
        // PBT_APMRESUMESUSPEND, PBT_APMRESUMEAUTOMATIC, PBT_APMPOWERSTATUSCHANGE,
        // PBT_POWERSETTINGCHANGE
        for kind in [0x0, 0x7, 0x12, 0xA, 0x8013] {
            assert_eq!(power_event(kind), None, "{kind:#x}");
        }
        let expected = [
            (0x1, None), // WTS_CONSOLE_CONNECT
            (0x2, Some(SystemEvent::SessionDisconnected)),
            (0x3, None), // WTS_REMOTE_CONNECT
            (0x4, Some(SystemEvent::SessionDisconnected)),
            (0x5, None), // WTS_SESSION_LOGON
            (0x6, Some(SystemEvent::LoggingOff)),
            (0x7, Some(SystemEvent::SessionLocked)),
            (0x8, None), // WTS_SESSION_UNLOCK
            (0x9, None), // WTS_SESSION_REMOTE_CONTROL
            (0xA, None), // WTS_SESSION_CREATE
            (0xB, None), // WTS_SESSION_TERMINATE
            (0xF, None), // WTS_SESSION_DESKTOP_READY
            (0x0, None),
            (u32::MAX, None),
        ];
        for (code, event) in expected {
            assert_eq!(session_event(code), event, "{code:#x}");
        }
    }

    #[test]
    fn watch_returns_a_guard() {
        // On Windows this starts and stops the real watcher; elsewhere it does nothing.
        assert!(watch(|_| {}).is_ok());
    }
}
