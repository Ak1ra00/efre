//! Navigation policy: the webview may only ever show efre's own bundled frontend.
//! A compromised script therefore cannot navigate away or carry data out in a URL.

use tauri::Url;

/// Port of the Vite dev server (`vite.config.ts`); allowed only in debug builds.
#[cfg(debug_assertions)]
const DEV_SERVER_PORT: u16 = 1420;

/// Origin of the bundled frontend (Tauri's `tauri` protocol as WebView2 or WebKit sees it).
#[cfg(windows)]
const BUNDLED_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
const BUNDLED_ORIGIN: &str = "tauri://localhost";

/// Returns true only for efre's own app origin.
pub(crate) fn is_app_url(url: &Url) -> bool {
    match (url.scheme(), url.host_str(), url.port()) {
        // Windows (WebView2) serves the bundled frontend from http://tauri.localhost.
        ("http", Some("tauri.localhost"), None) => true,
        // Linux/macOS custom protocol.
        ("tauri", Some("localhost"), None) => true,
        #[cfg(debug_assertions)]
        ("http", Some("localhost" | "127.0.0.1"), Some(DEV_SERVER_PORT)) => true,
        _ => false,
    }
}

/// The root of efre's frontend, the same base Tauri uses for `WebviewUrl::App`: the dev
/// server in dev mode, the bundled origin otherwise. Navigating there loads a fresh
/// document, which discards all JS state (lock, ARCHITECTURE §6.6). `None` if the result
/// would not be an app URL, in which case the caller reloads instead.
pub(crate) fn app_root_url(config: &tauri::Config) -> Option<Url> {
    let dev_server = if tauri::is_dev() {
        config.build.dev_url.clone()
    } else {
        None
    };
    let base = match dev_server {
        Some(url) => url,
        None => Url::parse(BUNDLED_ORIGIN).ok()?,
    };
    let root = base.join("/").ok()?;
    is_app_url(&root).then_some(root)
}

#[cfg(test)]
mod tests {
    use super::{app_root_url, is_app_url};
    use tauri::Url;

    #[test]
    fn root_url_is_the_app_origin() {
        let mut config = tauri::Config::default();
        let root = app_root_url(&config).expect("bundled origin");
        assert!(is_app_url(&root));
        assert_eq!(root.path(), "/");
        // Tests build without `custom-protocol`, i.e. in dev mode: the dev server wins.
        config.build.dev_url = Some(Url::parse("http://localhost:1420").expect("url"));
        assert_eq!(
            app_root_url(&config).map(String::from).as_deref(),
            Some("http://localhost:1420/")
        );
        // Never anything that the navigation policy would block.
        config.build.dev_url = Some(Url::parse("http://localhost:9999/app/").expect("url"));
        assert_eq!(app_root_url(&config), None);
    }

    fn allowed(s: &str) -> bool {
        is_app_url(&Url::parse(s).expect("valid test URL"))
    }

    #[test]
    fn allows_app_origin() {
        assert!(allowed("http://tauri.localhost/"));
        assert!(allowed("http://tauri.localhost/index.html#/items"));
        assert!(allowed("tauri://localhost/index.html"));
    }

    #[test]
    fn rejects_everything_else() {
        for url in [
            "https://example.com/",
            "http://tauri.localhost.evil.com/",
            "http://evil.com/?h=tauri.localhost",
            "http://tauri.localhost:8080/",
            "https://tauri.localhost/",
            "file:///C:/Windows/System32/",
            "about:blank",
            "data:text/html,hi",
            "javascript:alert(1)",
            "http://localhost:9999/",
        ] {
            assert!(!allowed(url), "{url} must be rejected");
        }
    }
}
