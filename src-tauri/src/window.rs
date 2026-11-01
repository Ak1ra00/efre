//! The single efre window, hardened per docs/ARCHITECTURE.md §8–§10.

use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::navigation;

pub(crate) const MAIN_LABEL: &str = "main";

/// WebView2 browser arguments. Keeps wry's defaults (which are replaced, not merged,
/// when this is set) and turns off background networking features.
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
);

pub(crate) fn create_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::App("index.html".into()))
        .title("efre")
        .inner_size(1120.0, 720.0)
        .min_inner_size(420.0, 560.0)
        .theme(Some(Theme::Dark))
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
        use tauri::Manager;
        let data_dir = app.path().local_data_dir()?.join("efre").join("webview");
        builder
            .additional_browser_args(WEBVIEW2_ARGS)
            .data_directory(data_dir)
    };

    builder.build()
}
