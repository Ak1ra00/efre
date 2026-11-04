//! Process hardening, applied first thing in `main`, before Tauri starts a thread or
//! creates a window, and before WebView2 is loaded (ARCHITECTURE §8.1):
//!
//! 1. `SetErrorMode`: adds `SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX` to the existing
//!    mode, so Windows shows no crash dialog (which keeps a crashed process, and its memory,
//!    alive until it is dismissed) and no "insert a disk" dialog.
//! 2. `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)`: a DLL found by search
//!    comes only from efre's folder, System32 or a folder added with `AddDllDirectory`,
//!    never from the current folder, `%windir%` or `PATH`.
//! 3. `SetProcessMitigationPolicy(ProcessImageLoadPolicy)`: no DLLs from remote shares or
//!    with a low mandatory label, and System32 first for DLLs found by search.
//! 4. `WerAddExcludedApplication(<exe file name>, FALSE)`: Windows Error Reporting leaves
//!    efre out of its reports and dumps. Per user, so no admin is needed.
//! 5. Removes every `WEBVIEW2_*` environment variable. The WebView2 loader and runtime read
//!    them, and they override or extend efre's own settings, for example
//!    `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…` (ARCHITECTURE §10).
//!
//! Every step is best effort. A step Windows refuses leaves efre running, and Settings ›
//! Security lists it as a limit. §8.1 records why strict handle checks and the other
//! mitigation policies stay off.

use std::ffi::OsStr;

use crate::security::Monitor;

/// What each startup step achieved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Hardening {
    /// Windows Error Reporting excludes efre (`WerAddExcludedApplication`).
    pub(crate) crash_reports: Monitor,
    /// No crash or critical-error dialogs (`SetErrorMode`).
    pub(crate) error_dialogs: Monitor,
    /// DLL search limited to efre's folder and System32 (`SetDefaultDllDirectories`).
    pub(crate) dll_search: Monitor,
    /// No DLLs from remote shares or with a low mandatory label (image-load policy).
    pub(crate) image_sources: Monitor,
    /// System32 first for DLLs found by search (image-load policy).
    pub(crate) system32_first: Monitor,
    /// No `WEBVIEW2_*` environment overrides.
    pub(crate) webview2_overrides: Monitor,
}

impl Hardening {
    /// Every step unavailable, for `reason`.
    #[cfg(any(not(windows), test))]
    pub(crate) fn not_applied(reason: &str) -> Self {
        let unavailable = || Monitor::Unavailable(reason.to_owned());
        Self {
            crash_reports: unavailable(),
            error_dialogs: unavailable(),
            dll_search: unavailable(),
            image_sources: unavailable(),
            system32_first: unavailable(),
            webview2_overrides: unavailable(),
        }
    }

    /// Every step in effect.
    #[cfg(test)]
    pub(crate) fn applied() -> Self {
        Self {
            crash_reports: Monitor::Active,
            error_dialogs: Monitor::Active,
            dll_search: Monitor::Active,
            image_sources: Monitor::Active,
            system32_first: Monitor::Active,
            webview2_overrides: Monitor::Active,
        }
    }
}

/// Applies every step and reports what took effect. Call it once, first thing in `main`,
/// while efre is still single-threaded.
#[cfg(windows)]
pub(crate) fn apply() -> Hardening {
    imp::apply()
}

/// Development platforms: nothing to harden.
#[cfg(not(windows))]
pub(crate) fn apply() -> Hardening {
    Hardening::not_applied("efre applies it on Windows only")
}

/// True for an environment variable the WebView2 loader or runtime reads: any name that
/// starts with `WEBVIEW2_`, in any case (Windows variable names ignore case).
#[cfg_attr(not(windows), allow(dead_code))]
fn is_webview2_override(name: &OsStr) -> bool {
    const PREFIX: &str = "WEBVIEW2_";
    name.to_string_lossy()
        .get(..PREFIX.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(PREFIX))
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt as _;

    use windows::Win32::System::Diagnostics::Debug::{
        GetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SetErrorMode,
        THREAD_ERROR_MODE,
    };
    use windows::Win32::System::Environment::SetEnvironmentVariableW;
    use windows::Win32::System::ErrorReporting::WerAddExcludedApplication;
    use windows::Win32::System::LibraryLoader::{
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, SetDefaultDllDirectories,
    };
    use windows::Win32::System::SystemServices::PROCESS_MITIGATION_IMAGE_LOAD_POLICY;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetProcessMitigationPolicy, ProcessImageLoadPolicy,
        SetProcessMitigationPolicy,
    };
    use windows::core::{Error, PCWSTR};

    use super::{Hardening, is_webview2_override};
    use crate::security::Monitor;

    // PROCESS_MITIGATION_IMAGE_LOAD_POLICY bit fields (winnt.h), in declaration order.
    const NO_REMOTE_IMAGES: u32 = 1 << 0;
    const NO_LOW_MANDATORY_LABEL_IMAGES: u32 = 1 << 1;
    const PREFER_SYSTEM32_IMAGES: u32 = 1 << 2;
    const IMAGE_SOURCES: u32 = NO_REMOTE_IMAGES | NO_LOW_MANDATORY_LABEL_IMAGES;

    pub(super) fn apply() -> Hardening {
        // Dialogs first: nothing after this may stop on a message box.
        let error_dialogs = error_mode();
        // Then the DLL rules, before anything else loads a library.
        let dll_search = dll_search();
        let (image_sources, system32_first) = image_load();
        let crash_reports = exclude_from_error_reporting();
        let webview2_overrides = remove_webview2_overrides();
        Hardening {
            crash_reports,
            error_dialogs,
            dll_search,
            image_sources,
            system32_first,
            webview2_overrides,
        }
    }

    fn refused(error: &Error) -> Monitor {
        Monitor::Unavailable(format!("Windows refused it (0x{:08X})", error.code().0))
    }

    /// NUL-terminated UTF-16.
    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain([0]).collect()
    }

    fn error_mode() -> Monitor {
        let wanted = SEM_FAILCRITICALERRORS.0 | SEM_NOGPFAULTERRORBOX.0;
        // SAFETY: reads this process's error mode; no arguments.
        let current = unsafe { GetErrorMode() };
        // SAFETY: sets this process's error mode to documented flags; no pointers. The
        // previous mode it returns is `current`.
        let _previous = unsafe { SetErrorMode(THREAD_ERROR_MODE(current | wanted)) };
        // SAFETY: as for the first read.
        let now = unsafe { GetErrorMode() };
        if now & wanted == wanted {
            Monitor::Active
        } else {
            Monitor::Unavailable("Windows did not keep the setting".to_owned())
        }
    }

    fn dll_search() -> Monitor {
        // SAFETY: takes flags only. It changes where later DLL searches in this process look.
        match unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) } {
            Ok(()) => Monitor::Active,
            Err(error) => refused(&error),
        }
    }

    fn set_image_load(flags: u32) -> windows::core::Result<()> {
        let mut policy = PROCESS_MITIGATION_IMAGE_LOAD_POLICY::default();
        policy.Anonymous.Flags = flags;
        // SAFETY: `policy` is an initialised PROCESS_MITIGATION_IMAGE_LOAD_POLICY, the length
        // is its exact size, and Windows only reads it during the call.
        unsafe {
            SetProcessMitigationPolicy(
                ProcessImageLoadPolicy,
                (&raw const policy).cast(),
                size_of_val(&policy),
            )
        }
    }

    /// The image-load flags Windows enforces on this process.
    fn enforced_image_load() -> Option<u32> {
        let mut policy = PROCESS_MITIGATION_IMAGE_LOAD_POLICY::default();
        // SAFETY: returns a pseudo handle for this process, which needs no closing.
        let process = unsafe { GetCurrentProcess() };
        // SAFETY: `policy` is writable and exactly the length passed; Windows fills it in.
        unsafe {
            GetProcessMitigationPolicy(
                process,
                ProcessImageLoadPolicy,
                (&raw mut policy).cast(),
                size_of_val(&policy),
            )
        }
        .ok()?;
        // SAFETY: both members of the union are a plain `u32`, so any value is valid.
        Some(unsafe { policy.Anonymous.Flags })
    }

    /// Returns (no remote / low-label images, System32 first).
    fn image_load() -> (Monitor, Monitor) {
        let all = set_image_load(IMAGE_SOURCES | PREFER_SYSTEM32_IMAGES);
        // A Windows that rejects PreferSystem32Images still gets the other two.
        let sources = match &all {
            Ok(()) => Ok(()),
            Err(_) => set_image_load(IMAGE_SOURCES),
        };
        // Report what Windows enforces, however it got there: an administrator's Exploit
        // Protection settings can apply these at launch, and Windows then refuses changes.
        let enforced = enforced_image_load();
        let outcome = |bits: u32, set: &windows::core::Result<()>| {
            let on = enforced.map_or(set.is_ok(), |flags| flags & bits == bits);
            match (on, set) {
                (true, _) => Monitor::Active,
                (false, Err(error)) => refused(error),
                (false, Ok(())) => Monitor::Unavailable("Windows did not apply it".to_owned()),
            }
        };
        (
            outcome(IMAGE_SOURCES, &sources),
            outcome(PREFER_SYSTEM32_IMAGES, &all),
        )
    }

    fn exclude_from_error_reporting() -> Monitor {
        let exe = std::env::current_exe().ok();
        let Some(name) = exe.as_deref().and_then(|path| path.file_name()) else {
            return Monitor::Unavailable("efre could not find its own file name".to_owned());
        };
        let name = wide(name);
        // SAFETY: `name` is NUL-terminated UTF-16 that outlives the call. FALSE writes the
        // per-user list, which needs no admin.
        match unsafe { WerAddExcludedApplication(PCWSTR(name.as_ptr()), false) } {
            Ok(()) => Monitor::Active,
            Err(error) => refused(&error),
        }
    }

    fn remove_webview2_overrides() -> Monitor {
        let mut failure = None;
        for (name, _) in std::env::vars_os() {
            if !is_webview2_override(&name) {
                continue;
            }
            let name = wide(&name);
            // SAFETY: `name` is NUL-terminated UTF-16 that outlives the call, and a null value
            // deletes the variable. Windows serialises access to the environment block, and
            // efre has no other thread yet.
            let removed = unsafe { SetEnvironmentVariableW(PCWSTR(name.as_ptr()), PCWSTR::null()) };
            if let Err(error) = removed {
                failure.get_or_insert(error);
            }
        }
        match failure {
            None => Monitor::Active,
            Some(error) => refused(&error),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // These change the test process for good, which is harmless for the other tests.
        // Excluding the test binary from Windows Error Reporting is not tested: it would
        // write a per-user registry value on every developer's PC.

        #[test]
        fn error_dialogs_are_turned_off() {
            assert_eq!(error_mode(), Monitor::Active);
            // SAFETY: reads this process's error mode.
            let mode = unsafe { GetErrorMode() };
            assert_eq!(mode & 0x3, 0x3);
        }

        #[test]
        fn dll_search_and_image_load_policies_apply() {
            assert_eq!(dll_search(), Monitor::Active);
            assert_eq!(image_load(), (Monitor::Active, Monitor::Active));
            let flags = enforced_image_load().expect("readable");
            assert_eq!(flags & 0x7, 0x7, "{flags:#x}");
            // Applying again (as a second instance would) still reports them in effect.
            assert_eq!(image_load(), (Monitor::Active, Monitor::Active));
        }

        #[test]
        fn webview2_overrides_are_removed() {
            let name = "WEBVIEW2_EFRE_HARDENING_TEST";
            // SAFETY: Windows serialises access to the environment block; this variable is
            // used by this test only.
            unsafe { std::env::set_var(name, "--remote-debugging-port=9222") };
            // SAFETY: as above.
            unsafe { std::env::set_var("Webview2_Efre_Mixed_Case_Test", "x") };
            assert_eq!(remove_webview2_overrides(), Monitor::Active);
            assert!(std::env::var_os(name).is_none());
            assert!(std::env::var_os("WEBVIEW2_EFRE_MIXED_CASE_TEST").is_none());
            assert!(std::env::var_os("PATH").is_some(), "other variables stay");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview2_overrides_are_recognised_in_any_case() {
        for name in [
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            "WEBVIEW2_USER_DATA_FOLDER",
            "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
            "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
            "webview2_additional_browser_arguments",
            "WebView2_",
        ] {
            assert!(is_webview2_override(OsStr::new(name)), "{name}");
        }
        for name in [
            "PATH",
            "WEBVIEW2",
            "WEBVIEW",
            "XWEBVIEW2_X",
            "MY_WEBVIEW2_X",
            "WEBVIEW2-X",
            "WEBVIÉW2_X",
            "",
        ] {
            assert!(!is_webview2_override(OsStr::new(name)), "{name}");
        }
    }

    #[test]
    fn not_applied_marks_every_step_unavailable() {
        let hardening = Hardening::not_applied("no reason");
        let unavailable = Monitor::Unavailable("no reason".to_owned());
        assert_eq!(
            hardening,
            Hardening {
                crash_reports: unavailable.clone(),
                error_dialogs: unavailable.clone(),
                dll_search: unavailable.clone(),
                image_sources: unavailable.clone(),
                system32_first: unavailable.clone(),
                webview2_overrides: unavailable,
            }
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn nothing_is_applied_off_windows() {
        assert_eq!(
            apply(),
            Hardening::not_applied("efre applies it on Windows only")
        );
    }
}
