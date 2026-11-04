//! Windows-specific pieces of the app shell: the WebAuthn authenticator, the YubiKey
//! presence watcher and "Open vault folder". Other platforms get inert fallbacks so the
//! app and its tests build everywhere (efre ships on Windows only).

use std::ffi::OsString;
use std::path::Path;

/// The argument that makes Explorer open `target`'s folder (`select`: with `target`
/// highlighted). `None` for a relative path, or one that can't be quoted exactly
/// (Windows paths never contain `"`).
pub(crate) fn explorer_argument(target: &Path, select: bool) -> Option<OsString> {
    if !target.is_absolute() || target.as_os_str().to_string_lossy().contains('"') {
        return None;
    }
    let mut argument = OsString::from(if select { "/select,\"" } else { "\"" });
    argument.push(target.as_os_str());
    argument.push("\"");
    Some(argument)
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsString;
    use std::io;
    use std::os::windows::ffi::OsStringExt as _;
    use std::os::windows::process::CommandExt as _;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    use windows::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;
    use windows::Win32::System::Threading::CREATE_DEFAULT_ERROR_MODE;

    /// The Windows WebAuthn API (`webauthn.dll`, System32 only), with the Windows
    /// Security dialog parented to `hwnd`, and its API version.
    #[cfg(not(feature = "dev-mock"))]
    pub(crate) fn authenticator(
        hwnd: isize,
    ) -> Result<(std::sync::Arc<dyn efre_authn::Authenticator>, u32), efre_authn::AuthnError> {
        let authenticator = efre_authn::windows::WindowsAuthenticator::new(hwnd)?;
        let version = authenticator.api_version();
        Ok((std::sync::Arc::new(authenticator), version))
    }

    /// Starts watching for YubiKeys and returns the watcher with the current state.
    /// `on_change` runs on a Windows thread-pool thread and must stay short.
    #[cfg(not(feature = "dev-mock"))]
    pub(crate) fn watch_presence(
        on_change: impl Fn(bool) + Send + Sync + 'static,
    ) -> Result<(efre_authn::presence_windows::PresenceWatcher, bool), efre_authn::AuthnError> {
        let watcher = efre_authn::presence_windows::PresenceWatcher::start(on_change)?;
        let present = watcher.is_present();
        Ok((watcher, present))
    }

    /// Turns off WebView2's browser accelerator keys (print, save page, find, reload,
    /// zoom, devtools) and its default context menu (print, save as, inspect), so the
    /// page can't be printed or saved to a file. Editing keys (Ctrl+C/V/X/A/Z) and the
    /// page's own shortcuts keep working. Must run on the UI thread, as `with_webview`
    /// does.
    pub(crate) fn disable_browser_ui(
        webview: &tauri::webview::PlatformWebview,
    ) -> windows::core::Result<()> {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows::core::Interface as _;

        let controller = webview.controller();
        // SAFETY: `controller` is the live WebView2 controller of efre's window, used
        // on the UI thread that owns it.
        let core = unsafe { controller.CoreWebView2() }?;
        // SAFETY: as above; `core` is that controller's live ICoreWebView2.
        let settings = unsafe { core.Settings() }?;
        // SAFETY: as above; `settings` belongs to that webview.
        unsafe { settings.SetAreDefaultContextMenusEnabled(false) }?;
        let settings: ICoreWebView2Settings3 = settings.cast()?;
        // SAFETY: as above.
        unsafe { settings.SetAreBrowserAcceleratorKeysEnabled(false) }
    }

    /// `C:\Windows`, from the OS rather than from the (inheritable) environment.
    fn windows_directory() -> io::Result<PathBuf> {
        let mut buffer = vec![0u16; 260];
        loop {
            // SAFETY: `buffer` is a valid, writable UTF-16 buffer and the binding passes
            // its exact length; Windows writes at most that many units.
            let written = unsafe { GetSystemWindowsDirectoryW(Some(&mut buffer)) };
            let written = usize::try_from(written).unwrap_or(usize::MAX);
            if written == 0 {
                return Err(io::Error::last_os_error());
            }
            if written < buffer.len() {
                buffer.truncate(written);
                let dir = PathBuf::from(OsString::from_wide(&buffer));
                if !dir.is_absolute() {
                    return Err(io::Error::other("the Windows directory is not absolute"));
                }
                return Ok(dir);
            }
            // Too small: `written` is the size needed, including the terminating NUL.
            if written > 32_768 {
                return Err(io::Error::other("the Windows directory path is too long"));
            }
            buffer.resize(written, 0);
        }
    }

    /// Opens Explorer on `target`: `%SystemRoot%\explorer.exe` by full path, never a
    /// shell or a `PATH` lookup.
    pub(crate) fn show_in_explorer(target: &Path, select: bool) -> io::Result<()> {
        let argument = super::explorer_argument(target, select)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let explorer = windows_directory()?.join("explorer.exe");
        let mut child = Command::new(explorer)
            // Explorer parses its own command line; pass `/select,"<path>"` verbatim.
            .raw_arg(argument)
            // Explorer may stay up as the user's shell: give it Windows' default error
            // mode, not the one efre sets for itself at startup (ARCHITECTURE §8.1).
            .creation_flags(CREATE_DEFAULT_ERROR_MODE.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        // Explorer usually hands the request to the running shell and exits at once,
        // but may stay up as the shell itself: reap it without blocking the caller.
        std::thread::Builder::new()
            .name("efre-explorer".into())
            .spawn(move || {
                let _ = child.wait();
            })?;
        Ok(())
    }
}

#[cfg(all(windows, not(feature = "dev-mock")))]
pub(crate) use imp::{authenticator, watch_presence};
#[cfg(windows)]
pub(crate) use imp::{disable_browser_ui, show_in_explorer};

/// Elsewhere there is no Explorer: checks the path the same way, then does nothing.
#[cfg(not(windows))]
pub(crate) fn show_in_explorer(target: &Path, select: bool) -> std::io::Result<()> {
    explorer_argument(target, select)
        .map(drop)
        .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_argument_quotes_the_path() {
        let vault = std::env::temp_dir().join("efre").join("vault.efre");
        let expected = format!("/select,\"{}\"", vault.display());
        assert_eq!(
            explorer_argument(&vault, true),
            Some(OsString::from(expected))
        );
        let dir = std::env::temp_dir().join("efre");
        assert_eq!(
            explorer_argument(&dir, false),
            Some(OsString::from(format!("\"{}\"", dir.display())))
        );
    }

    #[test]
    fn explorer_argument_refuses_relative_or_quoted_paths() {
        assert_eq!(explorer_argument(Path::new("vault.efre"), true), None);
        let quoted = std::env::temp_dir().join("a\"b");
        assert_eq!(explorer_argument(&quoted, true), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn showing_the_folder_is_a_no_op_elsewhere() {
        assert!(show_in_explorer(&std::env::temp_dir(), false).is_ok());
    }
}
