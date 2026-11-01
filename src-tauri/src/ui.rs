//! What Rust tells the webview: the `key-step` and `locked` events, and the reload to a
//! fresh document after a lock (docs/IPC.md, "Events"; ARCHITECTURE §6.6).

use tauri::{AppHandle, Emitter as _, Manager as _, Url};

use crate::dto::{KeyStepEvent, LockReason, LockedEvent};
use crate::{navigation, window};

pub(crate) const KEY_STEP_EVENT: &str = "key-step";
pub(crate) const LOCKED_EVENT: &str = "locked";

/// The webview, as seen by the app state. Behind a trait so tests can observe it.
pub(crate) trait Ui: Send + Sync {
    /// Right before each Windows Security prompt.
    fn key_step(&self, step: &KeyStepEvent);

    /// The vault locked: emit `locked`, then load a fresh document so every bit of JS
    /// state (including anything revealed) is discarded.
    fn locked(&self, reason: LockReason);
}

pub(crate) struct TauriUi {
    app: AppHandle,
    root: Option<Url>,
}

impl TauriUi {
    pub(crate) fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            root: navigation::app_root_url(app.config()),
        }
    }
}

impl Ui for TauriUi {
    fn key_step(&self, step: &KeyStepEvent) {
        let _ = self.app.emit(KEY_STEP_EVENT, step);
    }

    fn locked(&self, reason: LockReason) {
        let _ = self.app.emit(LOCKED_EVENT, LockedEvent { reason });
        let Some(webview) = self.app.get_webview_window(window::MAIN_LABEL) else {
            return;
        };
        // Both are asynchronous requests to the event loop, queued after the event.
        let _ = match &self.root {
            Some(root) => webview.navigate(root.clone()),
            None => webview.reload(),
        };
    }
}
