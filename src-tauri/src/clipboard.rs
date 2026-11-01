// STUB: replaced by Agent F's implementation at merge.
//! Clipboard (ARCHITECTURE §8.4).
//!
//! Placeholder with the final API only: copying always fails with
//! [`ClipboardError::Unavailable`] until the real implementation lands.

use std::sync::Arc;
use std::time::Duration;

use secrecy::SecretString;

#[derive(Clone)]
pub(crate) struct Clipboard {
    _inner: Arc<()>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ClipboardError {
    #[error("the clipboard is unavailable")]
    Unavailable,
}

impl Clipboard {
    pub(crate) fn new() -> Self {
        Self {
            _inner: Arc::new(()),
        }
    }

    pub(crate) fn copy_secret(
        &self,
        value: &SecretString,
        clear_after: Duration,
    ) -> Result<(), ClipboardError> {
        let _ = (value, clear_after);
        Err(ClipboardError::Unavailable)
    }

    pub(crate) fn clear_if_ours(&self) {}
}
