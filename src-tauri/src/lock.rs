//! Auto-lock triggers (ARCHITECTURE §8.5, §6.6, §6.7).
//!
//! [`LockTriggers`] decides *when* to lock, from cheap atomics only, so it can run in
//! OS callbacks and on the lock worker without touching the vault mutex (which a
//! Windows Security prompt may hold for minutes). The lock itself is
//! [`crate::state::AppState::lock_now`].
//!
//! * idle: a Rust-side deadline, reset by `activity` and by every command;
//! * unplug: when no YubiKey remains, except while a key flow (`setup_enroll_key`,
//!   `add_key`, `remove_key`) runs; when the last such flow ends with no YubiKey
//!   present, lock immediately;
//! * suspend, Windows lock, user switch and sign-out: always (see `system_events`);
//! * manual: the `lock` command.

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

/// A monotonic clock in milliseconds. Injectable so the idle logic can be tested.
pub(crate) trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

/// The real clock: milliseconds since the app started.
pub(crate) struct MonotonicClock(Instant);

impl MonotonicClock {
    pub(crate) fn new() -> Self {
        Self(Instant::now())
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.0.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// Auto-lock minutes used before a vault (and its settings) exists: during setup.
pub(crate) const DEFAULT_AUTO_LOCK_MINUTES: u16 = 5;

/// True once `minutes` have passed since `last_activity_ms`.
pub(crate) fn idle_expired(last_activity_ms: u64, now_ms: u64, minutes: u16) -> bool {
    let limit = u64::from(minutes.max(1)) * 60_000;
    now_ms.saturating_sub(last_activity_ms) >= limit
}

pub(crate) struct LockTriggers {
    clock: Box<dyn Clock>,
    last_activity_ms: AtomicU64,
    auto_lock_minutes: AtomicU16,
    /// Mirrors "the vault is unlocked"; written only while holding the vault mutex.
    unlocked: AtomicBool,
    /// Mirrors "a setup wizard holds a `VaultBuilder` (and so a VMK)".
    setup_active: AtomicBool,
    /// Running flows during which the unplug trigger is suspended.
    key_flows: AtomicUsize,
    /// Last known "a YubiKey is plugged in". Stays true where presence is not watched.
    present: AtomicBool,
    /// Bumped by every lock that wiped something; commands started earlier must not
    /// act on the vault afterwards.
    epoch: AtomicU64,
}

impl LockTriggers {
    pub(crate) fn new(clock: Box<dyn Clock>) -> Self {
        let now = clock.now_ms();
        Self {
            clock,
            last_activity_ms: AtomicU64::new(now),
            auto_lock_minutes: AtomicU16::new(DEFAULT_AUTO_LOCK_MINUTES),
            unlocked: AtomicBool::new(false),
            setup_active: AtomicBool::new(false),
            key_flows: AtomicUsize::new(0),
            present: AtomicBool::new(true),
            epoch: AtomicU64::new(0),
        }
    }

    /// User or IPC activity: restarts the idle deadline.
    pub(crate) fn touch(&self) {
        self.last_activity_ms
            .store(self.clock.now_ms(), Ordering::SeqCst);
    }

    /// Whether the idle trigger should lock now. Only applies while something holds
    /// secrets: an unlocked vault, or a setup wizard's builder.
    pub(crate) fn idle_due(&self) -> bool {
        let holds_secrets =
            self.unlocked.load(Ordering::SeqCst) || self.setup_active.load(Ordering::SeqCst);
        holds_secrets
            && idle_expired(
                self.last_activity_ms.load(Ordering::SeqCst),
                self.clock.now_ms(),
                self.auto_lock_minutes.load(Ordering::SeqCst),
            )
    }

    pub(crate) fn set_auto_lock_minutes(&self, minutes: u16) {
        self.auto_lock_minutes.store(minutes, Ordering::SeqCst);
    }

    /// The vault was unlocked (or created). Call while holding the vault mutex.
    pub(crate) fn set_unlocked(&self, auto_lock_minutes: u16) {
        self.set_auto_lock_minutes(auto_lock_minutes);
        self.touch();
        self.setup_active.store(false, Ordering::SeqCst);
        self.unlocked.store(true, Ordering::SeqCst);
    }

    /// A setup wizard started or ended. Call while holding the builder mutex.
    pub(crate) fn set_setup_active(&self, active: bool) {
        if active {
            self.set_auto_lock_minutes(DEFAULT_AUTO_LOCK_MINUTES);
            self.touch();
        }
        self.setup_active.store(active, Ordering::SeqCst);
    }

    /// Nothing holds secrets any more. Call while holding the vault mutex.
    pub(crate) fn set_locked(&self) {
        self.unlocked.store(false, Ordering::SeqCst);
        self.setup_active.store(false, Ordering::SeqCst);
    }

    pub(crate) fn is_unlocked(&self) -> bool {
        self.unlocked.load(Ordering::SeqCst)
    }

    pub(crate) fn begin_flow(&self) {
        self.key_flows.fetch_add(1, Ordering::SeqCst);
    }

    /// Ends a key flow. True if this was the last running flow and no YubiKey is
    /// plugged in while the vault is unlocked: lock now (ARCHITECTURE §6.7).
    pub(crate) fn end_flow(&self) -> bool {
        let previous = self
            .key_flows
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .unwrap_or(0);
        previous == 1 && !self.present.load(Ordering::SeqCst) && self.is_unlocked()
    }

    // Only the Windows presence watcher reports presence.
    #[cfg_attr(not(all(windows, not(feature = "dev-mock"))), allow(dead_code))]
    pub(crate) fn key_flow_running(&self) -> bool {
        self.key_flows.load(Ordering::SeqCst) > 0
    }

    /// Records a presence change. True if the unplug trigger should lock now: no
    /// YubiKey remains, the vault is unlocked and no key flow suspends the trigger.
    #[cfg_attr(not(all(windows, not(feature = "dev-mock"))), allow(dead_code))]
    pub(crate) fn set_present(&self, present: bool) -> bool {
        self.present.store(present, Ordering::SeqCst);
        !present && !self.key_flow_running() && self.is_unlocked()
    }

    pub(crate) fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    pub(crate) fn bump_epoch(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;

    use super::*;

    /// A clock the test moves by hand.
    #[derive(Clone, Default)]
    pub(crate) struct ManualClock(Arc<AtomicU64>);

    impl ManualClock {
        pub(crate) fn advance_secs(&self, secs: u64) {
            self.0.fetch_add(secs * 1000, Ordering::SeqCst);
        }
    }

    impl Clock for ManualClock {
        fn now_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn triggers() -> (LockTriggers, ManualClock) {
        let clock = ManualClock::default();
        (LockTriggers::new(Box::new(clock.clone())), clock)
    }

    #[test]
    fn idle_expiry_edges() {
        assert!(!idle_expired(0, 0, 5));
        assert!(!idle_expired(0, 299_999, 5));
        assert!(idle_expired(0, 300_000, 5));
        assert!(idle_expired(1_000, 61_000, 1));
        // A clock that went backwards never locks early, and 0 minutes means 1.
        assert!(!idle_expired(10_000, 5_000, 1));
        assert!(!idle_expired(0, 59_999, 0));
        assert!(idle_expired(0, 60_000, 0));
        assert!(idle_expired(0, 120 * 60_000, 120));
        assert!(!idle_expired(0, 120 * 60_000 - 1, 120));
    }

    #[test]
    fn idle_applies_only_while_secrets_are_held() {
        let (t, clock) = triggers();
        clock.advance_secs(3600);
        assert!(!t.idle_due(), "nothing to lock");

        t.set_unlocked(2);
        clock.advance_secs(119);
        assert!(!t.idle_due());
        clock.advance_secs(1);
        assert!(t.idle_due());

        // Activity restarts the deadline.
        t.touch();
        clock.advance_secs(119);
        assert!(!t.idle_due());
        // A shorter setting applies to the running deadline.
        t.set_auto_lock_minutes(1);
        assert!(t.idle_due());

        t.set_locked();
        assert!(!t.idle_due());

        // A setup wizard holds a VMK: the default timeout applies.
        t.set_setup_active(true);
        clock.advance_secs(u64::from(DEFAULT_AUTO_LOCK_MINUTES) * 60 - 1);
        assert!(!t.idle_due());
        clock.advance_secs(1);
        assert!(t.idle_due());
        t.set_setup_active(false);
        assert!(!t.idle_due());
    }

    #[test]
    fn unplug_locks_only_an_unlocked_vault_outside_key_flows() {
        let (t, _) = triggers();
        assert!(!t.set_present(false), "locked: nothing to do");
        assert!(!t.set_present(true));

        t.set_unlocked(5);
        assert!(!t.set_present(true));
        assert!(t.set_present(false), "unlocked, no flow: lock");
    }

    #[test]
    fn key_flows_suspend_unplug_and_lock_at_the_end_if_no_key_remains() {
        let (t, _) = triggers();
        t.set_unlocked(5);

        // Swap keys during a flow: unplugging does not lock...
        t.begin_flow();
        assert!(!t.set_present(false));
        assert!(t.key_flow_running());
        // ... and the flow ends with no key plugged in: lock now.
        assert!(t.end_flow());
        assert!(!t.key_flow_running());

        // The new key was plugged in before the flow ended: no lock.
        t.set_present(true);
        t.begin_flow();
        assert!(!t.set_present(false));
        assert!(!t.set_present(true));
        assert!(!t.end_flow());

        // Nested flows: only the last one to end decides.
        t.begin_flow();
        t.begin_flow();
        assert!(!t.set_present(false));
        assert!(!t.end_flow());
        assert!(t.end_flow());

        // Unbalanced ends never underflow.
        assert!(!t.end_flow());
        assert!(!t.key_flow_running());
    }

    #[test]
    fn flows_in_setup_never_lock_on_unplug() {
        let (t, _) = triggers();
        t.set_setup_active(true);
        t.begin_flow();
        assert!(!t.set_present(false));
        assert!(!t.end_flow(), "setup: swapping keys is expected");
        assert!(!t.set_present(false));
    }

    #[test]
    fn epoch_moves_forward() {
        let (t, _) = triggers();
        let before = t.epoch();
        t.bump_epoch();
        assert_eq!(t.epoch(), before + 1);
    }
}
