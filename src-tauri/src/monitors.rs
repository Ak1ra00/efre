//! The OS watchers behind the automatic lock triggers (ARCHITECTURE §8.5): YubiKey
//! presence, and suspend / Windows lock / user switch / sign-out. [`Monitors`] keeps
//! them registered; dropping it unregisters them. Their callbacks only hold a weak
//! reference to the app state and do no more than queue a lock.

use std::sync::Arc;

use crate::security::Monitor;
use crate::state::AppState;
use crate::system_events::{self, SystemEvents};

pub(crate) struct Monitors {
    #[cfg(all(windows, not(feature = "dev-mock")))]
    _presence: Option<efre_authn::presence_windows::PresenceWatcher>,
    _system_events: Option<SystemEvents>,
}

/// Starts every watcher this platform has. A watcher that can't start leaves its
/// trigger off, and Settings > Security lists it as a limit.
pub(crate) fn start(state: &Arc<AppState>) -> Monitors {
    let weak = Arc::downgrade(state);
    let system = system_events::watch(move |event| {
        if let Some(state) = weak.upgrade() {
            state.on_system_event(event);
        }
    });
    let system = match system {
        Ok(guard) => {
            state.set_system_events_monitor(Monitor::Active);
            Some(guard)
        }
        Err(reason) => {
            state.set_system_events_monitor(Monitor::Unavailable(reason));
            None
        }
    };

    #[cfg(not(all(windows, not(feature = "dev-mock"))))]
    state.set_presence_monitor(Monitor::Unavailable(
        if cfg!(feature = "dev-mock") {
            "this development build simulates its YubiKeys"
        } else {
            "efre watches YubiKeys on Windows only"
        }
        .to_owned(),
    ));

    Monitors {
        #[cfg(all(windows, not(feature = "dev-mock")))]
        _presence: start_presence(state),
        _system_events: system,
    }
}

#[cfg(all(windows, not(feature = "dev-mock")))]
fn start_presence(state: &Arc<AppState>) -> Option<efre_authn::presence_windows::PresenceWatcher> {
    let weak = Arc::downgrade(state);
    let watched = crate::platform::watch_presence(move |present| {
        if let Some(state) = weak.upgrade() {
            state.on_presence(present);
        }
    });
    match watched {
        Ok((watcher, present)) => {
            state.on_presence(present);
            state.set_presence_monitor(Monitor::Active);
            Some(watcher)
        }
        Err(error) => {
            state.set_presence_monitor(Monitor::Unavailable(format!(
                "Windows could not report USB devices ({error})"
            )));
            None
        }
    }
}
