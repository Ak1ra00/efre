// STUB: replaced by Agent F's implementation at merge.
//! Suspend, Windows lock, user switch and sign-out notifications (ARCHITECTURE §8.5).
//!
//! Placeholder with the final API only: [`watch`] always fails, so these lock
//! triggers are reported as unavailable until the real implementation lands.

// Nothing constructs these until the real implementation exists.
#![allow(dead_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SystemEvent {
    Suspend,
    SessionLocked,
    SessionDisconnected,
    LoggingOff,
}

pub(crate) struct SystemEvents {
    _private: (),
}

pub(crate) fn watch(
    on_event: impl Fn(SystemEvent) + Send + Sync + 'static,
) -> Result<SystemEvents, String> {
    drop(on_event);
    Err("system event notifications are not implemented yet".to_owned())
}
