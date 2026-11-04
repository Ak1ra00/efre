//! The single efre window, hardened per docs/ARCHITECTURE.md §8–§10.

use std::sync::Arc;

use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::window::Color;
use tauri::{AppHandle, Manager as _, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::navigation;
use crate::security::Monitor;
use crate::state::AppState;

pub(crate) const MAIN_LABEL: &str = "main";

/// Window and webview background (#0e0f11), so nothing flashes white before the UI
/// has painted.
const BACKGROUND: Color = Color(0x0e, 0x0f, 0x11, 0xff);

/// WebView2 browser arguments. Keeps wry's defaults (which are replaced, not merged,
/// when this is set) and turns off background networking features.
///
/// `--host-resolver-rules` makes every host name lookup in WebView2's network service
/// fail. efre's own pages and IPC (`tauri.localhost`, `ipc.localhost`) are answered
/// inside WebView2 before any lookup, so nothing efre needs is lost. Anything that would
/// reach the network stack, such as Chromium opening a speculative connection to the
/// app's `*.localhost` origin on port 80, now fails before a socket exists
/// (ARCHITECTURE §10).
#[cfg(windows)]
const WEBVIEW2_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    " --disable-background-networking",
    " --disable-component-update",
    " --disable-domain-reliability",
    " --disable-sync",
    " --no-pings",
    " --disable-client-side-phishing-detection",
    " --no-first-run",
    " --host-resolver-rules=\"MAP * ~NOTFOUND\"",
);

pub(crate) fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("efre")
        .inner_size(1120.0, 720.0)
        .min_inner_size(420.0, 560.0)
        .theme(Some(Theme::Dark))
        .background_color(BACKGROUND)
        // Screenshot / screen-recording blocking (WDA_EXCLUDEFROMCAPTURE on Windows).
        .content_protected(true)
        .incognito(true)
        .general_autofill_enabled(false)
        .on_navigation(navigation::is_app_url)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_webview, _event| false)
        .on_permission_request(|_webview, _kind| PermissionResponse::Deny);

    #[cfg(windows)]
    let builder = {
        let data_dir = app.path().local_data_dir()?.join("efre").join("webview");
        builder
            .additional_browser_args(WEBVIEW2_ARGS)
            .data_directory(data_dir)
    };

    builder.build()
}

/// Turns off the browser's own accelerator keys and context menu (Windows; Tauri has
/// no builder option for them), then starts the page over so the document the user
/// sees runs with them off. Runs on the main thread before the event loop has served
/// the first page. The outcome is listed in Settings > Security.
pub(crate) fn lock_down_browser_ui(app: &AppHandle, state: &Arc<AppState>) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        state.set_browser_ui_monitor(Monitor::Unavailable(
            "efre could not find its window".to_owned(),
        ));
        return;
    };
    #[cfg(windows)]
    {
        let weak = Arc::downgrade(state);
        let reached = window.with_webview(move |webview| {
            let monitor = match crate::platform::disable_browser_ui(&webview) {
                Ok(()) => Monitor::Active,
                Err(error) => Monitor::Unavailable(format!(
                    "WebView2 refused the setting (0x{:08X})",
                    error.code().0
                )),
            };
            if let Some(state) = weak.upgrade() {
                state.set_browser_ui_monitor(monitor);
            }
        });
        if reached.is_err() {
            state.set_browser_ui_monitor(Monitor::Unavailable(
                "efre could not reach its webview".to_owned(),
            ));
        }
        // Queued after the settings: replaces the first, not yet served, navigation.
        if let Some(root) = navigation::app_root_url(app.config()) {
            let _ = window.navigate(root);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        state.set_browser_ui_monitor(Monitor::Unavailable(
            "efre turns them off on Windows only".to_owned(),
        ));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::WEBVIEW2_ARGS;

    #[test]
    fn webview2_args_keep_wry_defaults_and_block_every_host_lookup() {
        assert!(
            WEBVIEW2_ARGS
                .starts_with("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ")
        );
        assert!(WEBVIEW2_ARGS.ends_with(" --host-resolver-rules=\"MAP * ~NOTFOUND\""));
        for flag in [
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-domain-reliability",
            "--disable-sync",
            "--no-pings",
        ] {
            assert!(WEBVIEW2_ARGS.split(' ').any(|arg| arg == flag), "{flag}");
        }
    }
}
