//! Navigation policy: the webview may only ever show efre's own bundled frontend.
//! A compromised script therefore cannot navigate away or carry data out in a URL.

use tauri::Url;

/// Port of the Vite dev server (`vite.config.ts`); allowed only in debug builds.
#[cfg(debug_assertions)]
const DEV_SERVER_PORT: u16 = 1420;

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

#[cfg(test)]
mod tests {
    use super::is_app_url;
    use tauri::Url;

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
