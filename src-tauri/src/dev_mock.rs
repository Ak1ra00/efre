//! Two simulated YubiKeys, for running the UI without hardware (feature `dev-mock`,
//! debug builds only; ARCHITECTURE §11). Each "prompt" is a short, cancellable pause.
//! When the simulated key in the "port" can't answer (already enrolled, or not
//! enrolled in this vault), the other one is "plugged in" and asked instead, which
//! is what a user swapping keys would do.

#[cfg(not(debug_assertions))]
compile_error!("efre's `dev-mock` feature must never be enabled in a release build");

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

use efre_authn::mock::{MockAuthenticator, MockKeyId};
use efre_authn::{AssertRequest, Assertion, Authenticator, AuthnError, EnrollRequest, Enrollment};

/// How long a simulated Windows Security prompt stays open.
const PROMPT: Duration = Duration::from_millis(700);
const TICK: Duration = Duration::from_millis(50);

pub(crate) struct DevMockAuthenticator {
    mock: MockAuthenticator,
    keys: [MockKeyId; 2],
    inserted: AtomicUsize,
    cancelled: AtomicBool,
}

impl DevMockAuthenticator {
    pub(crate) fn new() -> Self {
        let mock = MockAuthenticator::new();
        let keys = [mock.add_key("dev key 1"), mock.add_key("dev key 2")];
        mock.insert(keys[0]);
        Self {
            mock,
            keys,
            inserted: AtomicUsize::new(0),
            cancelled: AtomicBool::new(false),
        }
    }

    /// Stands in for the Windows Security dialog: a short pause that `cancel` ends.
    fn prompt(&self) -> Result<(), AuthnError> {
        self.cancelled.store(false, Ordering::SeqCst);
        let mut waited = Duration::ZERO;
        while waited < PROMPT {
            if self.cancelled.swap(false, Ordering::SeqCst) {
                return Err(AuthnError::Cancelled);
            }
            thread::sleep(TICK);
            waited += TICK;
        }
        Ok(())
    }

    /// "Plugs in" the other simulated key.
    fn swap_keys(&self) {
        let next = (self.inserted.load(Ordering::SeqCst) + 1) % self.keys.len();
        self.inserted.store(next, Ordering::SeqCst);
        self.mock.insert(self.keys[next]);
    }
}

impl Authenticator for DevMockAuthenticator {
    fn enroll(&self, request: &EnrollRequest<'_>) -> Result<Enrollment, AuthnError> {
        self.prompt()?;
        match self.mock.enroll(request) {
            Err(AuthnError::AlreadyEnrolled) => {
                self.swap_keys();
                self.mock.enroll(request)
            }
            other => other,
        }
    }

    fn assert(&self, request: &AssertRequest<'_>) -> Result<Assertion, AuthnError> {
        self.prompt()?;
        match self.mock.assert(request) {
            Err(AuthnError::UnknownKey) => {
                self.swap_keys();
                self.mock.assert(request)
            }
            other => other,
        }
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}
