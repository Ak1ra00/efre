//! Copying secrets to the clipboard and clearing them again (ARCHITECTURE §8.4).
//!
//! On Windows:
//! - efre writes the text with arboard and adds `ExcludeClipboardContentFromMonitorProcessing`,
//!   `CanIncludeInClipboardHistory = 0` and `CanUploadToCloudClipboard = 0`, so clipboard
//!   history, cloud sync and well-behaved clipboard monitors skip it.
//! - Right after the write it records `GetClipboardSequenceNumber()`.
//! - It clears the clipboard after the timeout, and whenever [`Clipboard::clear_if_ours`] is
//!   called (on lock and on quit), but only if the sequence number is unchanged, meaning
//!   nobody has copied anything since. The check and the clear happen while efre holds the
//!   clipboard open, so no other program can copy in between.
//! - efre never reads the clipboard back, and keeps nothing of the value except that
//!   sequence number.
//!
//! Other platforms are for development only. There, "still ours" means the SHA-256 of the
//! clipboard text equals the SHA-256 of what efre copied.
//!
//! The timing logic is written against the small `Backend` trait, so it is unit-tested with a
//! fake clipboard (CI has no display).

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use secrecy::{ExposeSecret, SecretString};

/// Copying to the clipboard failed. The UI shows its own message for this.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClipboardError {
    #[error("the clipboard is unavailable")]
    Unavailable,
}

/// The app's clipboard. Clones share one state, so the latest copy always wins.
#[derive(Clone)]
pub(crate) struct Clipboard {
    engine: Arc<Engine<os::System>>,
}

impl Clipboard {
    /// Does not touch the OS clipboard until the first copy.
    pub(crate) fn new() -> Self {
        Self {
            engine: Arc::new(Engine::new(os::System::new())),
        }
    }

    /// Puts `value` on the clipboard and clears it after `clear_after`, if it is still there.
    ///
    /// A new copy replaces the pending clear of the previous one. The value is not kept: the
    /// clipboard holds the only copy.
    ///
    /// # Errors
    /// [`ClipboardError::Unavailable`] if the clipboard cannot be written (for example while
    /// another program holds it open), if Windows cannot apply the history and cloud
    /// exclusions, or if `clear_after` is too large to schedule. In those cases nothing of the
    /// value is left on the clipboard.
    pub(crate) fn copy_secret(
        &self,
        value: &SecretString,
        clear_after: Duration,
    ) -> Result<(), ClipboardError> {
        self.engine.copy(value.expose_secret(), clear_after)
    }

    /// Clears the clipboard now if it still holds the value efre copied last. Used on lock and
    /// on quit. If another program holds the clipboard open, the clear is retried in the
    /// background until it succeeds or the value is gone.
    pub(crate) fn clear_if_ours(&self) {
        self.engine.clear_if_ours();
    }
}

impl Default for Clipboard {
    fn default() -> Self {
        Self::new()
    }
}

/// What the timing logic needs from the OS clipboard.
trait Backend: Send + 'static {
    /// Identifies the clipboard contents efre wrote.
    type Mark: Send + 'static;

    /// Puts `text` on the clipboard, excluded from history, cloud sync and clipboard
    /// monitors, and returns the mark of the new contents. On error, none of `text` may be
    /// left on the clipboard.
    fn set(&mut self, text: &str) -> Result<Self::Mark, ClipboardError>;

    /// Empties the clipboard if it still holds the contents identified by `mark`. `Ok` means
    /// none of efre's value is left: it was cleared, or something else replaced it. An error
    /// means the clipboard could not be accessed now; the caller retries later.
    fn clear_if_unchanged(&mut self, mark: &Self::Mark) -> Result<(), ClipboardError>;
}

/// How long to wait before retrying a clear that found the clipboard busy.
const RETRY: Duration = Duration::from_millis(500);

/// The clear-after-timeout state machine, shared by all clones and the timer threads.
struct Engine<B: Backend> {
    state: Mutex<State<B>>,
    /// Wakes timer threads when the pending clear changes.
    wake: Condvar,
}

struct State<B: Backend> {
    backend: B,
    /// The last value efre copied, if it may still be on the clipboard.
    pending: Option<Pending<B::Mark>>,
    /// Incremented by every copy. A timer thread whose generation is no longer the pending
    /// one has been superseded, and exits.
    generation: u64,
}

struct Pending<M> {
    mark: M,
    generation: u64,
    /// When to clear (or retry clearing).
    due: Instant,
}

impl<B: Backend> Engine<B> {
    fn new(backend: B) -> Self {
        Self {
            state: Mutex::new(State {
                backend,
                pending: None,
                generation: 0,
            }),
            wake: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State<B>> {
        // Every critical section leaves the state consistent, so a poisoned lock is still
        // usable. Giving up instead would leave the value on the clipboard.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn copy(self: &Arc<Self>, text: &str, clear_after: Duration) -> Result<(), ClipboardError> {
        let due = Instant::now()
            .checked_add(clear_after)
            .ok_or(ClipboardError::Unavailable)?;
        let mut state = self.lock();
        let mark = state.backend.set(text)?;
        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;
        // This replaces the previous pending clear: that value is no longer on the
        // clipboard, and its timer thread exits when woken.
        state.pending = Some(Pending {
            mark,
            generation,
            due,
        });
        let engine = Arc::clone(self);
        let timer = thread::Builder::new()
            .name("efre-clipboard".into())
            .spawn(move || engine.run_timer(generation));
        let result = match timer {
            Ok(_) => Ok(()),
            Err(_) => {
                // Without a timer the value would stay on the clipboard: clear it now. If the
                // clipboard is busy it stays pending, for the next lock or quit.
                Self::clear_pending(&mut state);
                Err(ClipboardError::Unavailable)
            }
        };
        drop(state);
        self.wake.notify_all();
        result
    }

    fn clear_if_ours(&self) {
        let mut state = self.lock();
        Self::clear_pending(&mut state);
        drop(state);
        self.wake.notify_all();
    }

    /// Clears the pending value if the clipboard still holds it. Returns false if the
    /// clipboard was busy; the value then stays pending and is due again after [`RETRY`].
    fn clear_pending(state: &mut State<B>) -> bool {
        let Some(pending) = state.pending.take() else {
            return true;
        };
        if state.backend.clear_if_unchanged(&pending.mark).is_ok() {
            return true;
        }
        let now = Instant::now();
        state.pending = Some(Pending {
            due: now.checked_add(RETRY).unwrap_or(now),
            ..pending
        });
        false
    }

    /// Body of the timer thread started by the copy of `generation`.
    fn run_timer(&self, generation: u64) {
        let mut state = self.lock();
        loop {
            let due = match &state.pending {
                Some(pending) if pending.generation == generation => pending.due,
                // Cleared, or replaced by a newer copy (which has its own timer).
                _ => return,
            };
            let now = Instant::now();
            if now < due {
                state = match self.wake.wait_timeout(state, due - now) {
                    Ok((guard, _)) => guard,
                    Err(poisoned) => poisoned.into_inner().0,
                };
                continue;
            }
            if Self::clear_pending(&mut state) {
                return;
            }
        }
    }
}

#[cfg(windows)]
mod os {
    use std::marker::PhantomData;
    use std::thread;
    use std::time::Duration;

    use arboard::SetExtWindows;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::core::w;

    use super::{Backend, ClipboardError};

    /// Like arboard: another program may hold the clipboard open for a moment.
    const OPEN_ATTEMPTS: u32 = 5;
    const OPEN_RETRY: Duration = Duration::from_millis(5);

    /// The Windows clipboard. arboard opens and closes it for every operation, so this holds
    /// no state.
    pub(super) struct System;

    impl System {
        pub(super) fn new() -> Self {
            Self
        }
    }

    impl Backend for System {
        /// `GetClipboardSequenceNumber()` right after efre's write.
        type Mark = u32;

        fn set(&mut self, text: &str) -> Result<u32, ClipboardError> {
            if !exclusion_formats_registered() {
                return Err(ClipboardError::Unavailable);
            }
            let before = sequence_number();
            let written = arboard::Clipboard::new().and_then(|mut clipboard| {
                clipboard
                    .set()
                    .exclude_from_monitoring()
                    .exclude_from_history()
                    .exclude_from_cloud()
                    .text(text)
            });
            let after = sequence_number();
            match written {
                // Every write changes the sequence number. If it did not (for example
                // because Windows reports 0 without clipboard access), efre could not tell
                // later whether the value is still its own, so that counts as a failure.
                Ok(()) if after != before => Ok(after),
                Ok(()) => {
                    let _ = clear_if_sequence(after);
                    Err(ClipboardError::Unavailable)
                }
                Err(_) => {
                    // arboard writes the text before the exclusion formats, so a failure
                    // can leave the text there without them. Take it off again (unless
                    // someone else has copied in the meantime).
                    if after != before {
                        let _ = clear_if_sequence(after);
                    }
                    Err(ClipboardError::Unavailable)
                }
            }
        }

        fn clear_if_unchanged(&mut self, mark: &u32) -> Result<(), ClipboardError> {
            clear_if_sequence(*mark)
        }
    }

    /// arboard silently skips an exclusion format that Windows refuses to register.
    /// Registering them first makes that impossible: a registered format stays registered,
    /// and registering it again returns the same id.
    fn exclusion_formats_registered() -> bool {
        [
            w!("ExcludeClipboardContentFromMonitorProcessing"),
            w!("CanIncludeInClipboardHistory"),
            w!("CanUploadToCloudClipboard"),
        ]
        .into_iter()
        .all(|name| {
            // SAFETY: `name` is a static, NUL-terminated UTF-16 string from `w!`.
            let format = unsafe { RegisterClipboardFormatW(name) };
            format != 0
        })
    }

    fn sequence_number() -> u32 {
        // SAFETY: GetClipboardSequenceNumber has no preconditions.
        unsafe { GetClipboardSequenceNumber() }
    }

    /// Empties the clipboard if its sequence number is still `mark`. The clipboard is open
    /// for the check and the clear, so nothing can be copied in between.
    fn clear_if_sequence(mark: u32) -> Result<(), ClipboardError> {
        let _open = OpenedClipboard::open()?;
        if sequence_number() != mark {
            return Ok(());
        }
        // SAFETY: this thread has the clipboard open (`_open`).
        unsafe { EmptyClipboard() }.map_err(|_| ClipboardError::Unavailable)
    }

    /// The clipboard, opened by this thread and closed on drop. It is `!Send` because only
    /// the thread that opened the clipboard may close it.
    struct OpenedClipboard(PhantomData<*const ()>);

    impl OpenedClipboard {
        fn open() -> Result<Self, ClipboardError> {
            for attempt in 0..OPEN_ATTEMPTS {
                if attempt > 0 {
                    thread::sleep(OPEN_RETRY);
                }
                // SAFETY: a null owner window is allowed. The clipboard then stays open for
                // this thread until `Drop` closes it, on this same thread.
                if unsafe { OpenClipboard(None) }.is_ok() {
                    return Ok(Self(PhantomData));
                }
            }
            Err(ClipboardError::Unavailable)
        }
    }

    impl Drop for OpenedClipboard {
        fn drop(&mut self) {
            // SAFETY: this thread opened the clipboard in `open`.
            let _ = unsafe { CloseClipboard() };
        }
    }

    /// Uses the real clipboard, so it is not run by default:
    /// `cargo test -p efre clipboard -- --ignored`
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        #[ignore = "overwrites and clears the real Windows clipboard"]
        fn sequence_number_guards_the_clear() {
            let mut system = System::new();

            // Unchanged since efre's copy: cleared.
            let mark = system.set("efre clipboard test").unwrap();
            assert_eq!(mark, sequence_number());
            system.clear_if_unchanged(&mark).unwrap();
            assert_ne!(sequence_number(), mark);
            let mut clipboard = arboard::Clipboard::new().unwrap();
            assert!(matches!(
                clipboard.get_text(),
                Err(arboard::Error::ContentNotAvailable)
            ));

            // Someone else copied since: left alone.
            let mark = system.set("efre clipboard test").unwrap();
            clipboard.set_text("someone else").unwrap();
            system.clear_if_unchanged(&mark).unwrap();
            assert_eq!(clipboard.get_text().unwrap(), "someone else");
            clipboard.clear().unwrap();
        }
    }
}

#[cfg(not(windows))]
mod os {
    use sha2::{Digest, Sha256};
    use zeroize::Zeroizing;

    use super::{Backend, ClipboardError};

    /// Development fallback (Linux, macOS).
    pub(super) struct System {
        /// Kept alive: on X11 the copying program serves the clipboard contents.
        clipboard: Option<arboard::Clipboard>,
    }

    impl System {
        pub(super) fn new() -> Self {
            Self { clipboard: None }
        }

        fn clipboard(&mut self) -> Result<&mut arboard::Clipboard, ClipboardError> {
            if self.clipboard.is_none() {
                let clipboard =
                    arboard::Clipboard::new().map_err(|_| ClipboardError::Unavailable)?;
                self.clipboard = Some(clipboard);
            }
            self.clipboard.as_mut().ok_or(ClipboardError::Unavailable)
        }
    }

    fn digest(text: &str) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(Sha256::digest(text.as_bytes()).into())
    }

    impl Backend for System {
        /// SHA-256 of the copied text.
        type Mark = Zeroizing<[u8; 32]>;

        fn set(&mut self, text: &str) -> Result<Self::Mark, ClipboardError> {
            self.clipboard()?
                .set_text(text)
                .map_err(|_| ClipboardError::Unavailable)?;
            Ok(digest(text))
        }

        fn clear_if_unchanged(&mut self, mark: &Self::Mark) -> Result<(), ClipboardError> {
            let clipboard = self.clipboard()?;
            let current = match clipboard.get_text() {
                Ok(text) => Zeroizing::new(text),
                // Empty, or not text: none of efre's value is left.
                Err(arboard::Error::ContentNotAvailable) => return Ok(()),
                Err(_) => return Err(ClipboardError::Unavailable),
            };
            if *digest(&current) != **mark {
                return Ok(());
            }
            clipboard.clear().map_err(|_| ClipboardError::Unavailable)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the fake OS clipboard holds.
    #[derive(Default)]
    struct FakeClipboard {
        text: Option<String>,
        sequence: u32,
        /// Another program holds the clipboard open.
        busy: bool,
        /// Writing fails.
        broken: bool,
        clear_attempts: usize,
    }

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<FakeClipboard>>);

    impl Fake {
        fn with<T>(&self, f: impl FnOnce(&mut FakeClipboard) -> T) -> T {
            f(&mut self.0.lock().unwrap())
        }

        fn text(&self) -> Option<String> {
            self.with(|c| c.text.clone())
        }

        fn clear_attempts(&self) -> usize {
            self.with(|c| c.clear_attempts)
        }

        fn other_program_copies(&self, text: &str) {
            self.with(|c| {
                c.text = Some(text.to_owned());
                c.sequence += 1;
            });
        }
    }

    impl Backend for Fake {
        type Mark = u32;

        fn set(&mut self, text: &str) -> Result<u32, ClipboardError> {
            self.with(|c| {
                if c.busy || c.broken {
                    return Err(ClipboardError::Unavailable);
                }
                c.text = Some(text.to_owned());
                c.sequence += 1;
                Ok(c.sequence)
            })
        }

        fn clear_if_unchanged(&mut self, mark: &u32) -> Result<(), ClipboardError> {
            self.with(|c| {
                c.clear_attempts += 1;
                if c.busy {
                    return Err(ClipboardError::Unavailable);
                }
                if c.sequence == *mark {
                    c.text = None;
                    c.sequence += 1;
                }
                Ok(())
            })
        }
    }

    fn engine() -> (Arc<Engine<Fake>>, Fake) {
        let fake = Fake::default();
        (Arc::new(Engine::new(fake.clone())), fake)
    }

    const LONG: Duration = Duration::from_secs(600);
    const SHORT: Duration = Duration::from_millis(30);

    /// Polls `condition` for up to 10 s.
    fn eventually(condition: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        condition()
    }

    /// The engine is referenced only by the test, so every timer thread has exited.
    fn timers_gone(engine: &Arc<Engine<Fake>>) -> bool {
        eventually(|| Arc::strong_count(engine) == 1)
    }

    #[test]
    fn clears_after_the_timeout() {
        let (engine, fake) = engine();
        engine.copy("secret", SHORT).unwrap();
        assert!(eventually(|| fake.text().is_none()));
        assert_eq!(fake.clear_attempts(), 1);
        assert!(timers_gone(&engine));
    }

    #[test]
    fn does_not_clear_early() {
        let (engine, fake) = engine();
        engine.copy("secret", LONG).unwrap();
        thread::sleep(Duration::from_millis(200));
        assert_eq!(fake.text().as_deref(), Some("secret"));
        assert_eq!(fake.clear_attempts(), 0);
        engine.clear_if_ours();
        assert!(timers_gone(&engine));
    }

    #[test]
    fn leaves_what_another_program_copied() {
        let (engine, fake) = engine();
        engine.copy("secret", SHORT).unwrap();
        fake.other_program_copies("theirs");
        assert!(eventually(|| fake.clear_attempts() == 1));
        assert!(timers_gone(&engine));
        assert_eq!(fake.text().as_deref(), Some("theirs"));
    }

    #[test]
    fn clear_if_ours_clears_now_and_only_once() {
        let (engine, fake) = engine();
        engine.copy("secret", LONG).unwrap();
        engine.clear_if_ours();
        assert_eq!(fake.text(), None);
        assert_eq!(fake.clear_attempts(), 1);
        assert!(timers_gone(&engine));
        // Nothing pending any more: no further attempts, even after someone else copies.
        fake.other_program_copies("theirs");
        engine.clear_if_ours();
        assert_eq!(fake.clear_attempts(), 1);
        assert_eq!(fake.text().as_deref(), Some("theirs"));
    }

    #[test]
    fn clear_if_ours_leaves_what_another_program_copied() {
        let (engine, fake) = engine();
        engine.copy("secret", LONG).unwrap();
        fake.other_program_copies("theirs");
        engine.clear_if_ours();
        assert_eq!(fake.text().as_deref(), Some("theirs"));
        assert!(timers_gone(&engine));
    }

    #[test]
    fn clear_if_ours_without_a_copy_does_nothing() {
        let (engine, fake) = engine();
        engine.clear_if_ours();
        assert_eq!(fake.clear_attempts(), 0);
    }

    #[test]
    fn a_new_copy_replaces_the_pending_clear() {
        let (engine, fake) = engine();
        // The first timer would fire soon, but the second copy supersedes it: after the
        // first deadline has passed, the second value is still there.
        engine.copy("first", Duration::from_millis(100)).unwrap();
        engine.copy("second", LONG).unwrap();
        thread::sleep(Duration::from_millis(400));
        assert_eq!(fake.text().as_deref(), Some("second"));
        // Only the second copy's timer is still running.
        assert!(eventually(|| Arc::strong_count(&engine) == 2));
        engine.clear_if_ours();
        assert_eq!(fake.text(), None);
        assert!(timers_gone(&engine));

        // A shorter second timeout fires on its own schedule.
        engine.copy("third", LONG).unwrap();
        engine.copy("fourth", SHORT).unwrap();
        assert!(eventually(|| fake.text().is_none()));
        assert!(timers_gone(&engine));
    }

    #[test]
    fn busy_clipboard_is_retried_until_it_clears() {
        let (engine, fake) = engine();
        engine.copy("secret", LONG).unwrap();
        fake.with(|c| c.busy = true);
        engine.clear_if_ours(); // e.g. on lock: fails, stays pending
        assert_eq!(fake.text().as_deref(), Some("secret"));
        assert!(eventually(|| fake.clear_attempts() >= 2)); // the timer retries
        fake.with(|c| c.busy = false);
        assert!(eventually(|| fake.text().is_none()));
        assert!(timers_gone(&engine));
    }

    #[test]
    fn failed_copy_is_reported_and_keeps_the_previous_clear() {
        let (engine, fake) = engine();
        engine.copy("first", LONG).unwrap();
        fake.with(|c| c.broken = true);
        assert!(matches!(
            engine.copy("second", LONG),
            Err(ClipboardError::Unavailable)
        ));
        fake.with(|c| c.broken = false);
        assert_eq!(fake.text().as_deref(), Some("first"));
        engine.clear_if_ours();
        assert_eq!(fake.text(), None);
        assert!(timers_gone(&engine));
    }

    #[test]
    fn unschedulable_timeout_copies_nothing() {
        let (engine, fake) = engine();
        assert!(matches!(
            engine.copy("secret", Duration::MAX),
            Err(ClipboardError::Unavailable)
        ));
        assert_eq!(fake.text(), None);
    }

    #[test]
    fn zero_timeout_clears_at_once() {
        let (engine, fake) = engine();
        engine.copy("secret", Duration::ZERO).unwrap();
        assert!(eventually(|| fake.text().is_none()));
        assert!(timers_gone(&engine));
    }

    #[test]
    fn app_clipboard_needs_no_display_until_used() {
        // Construction and a clear with nothing pending never touch the OS clipboard.
        let clipboard = Clipboard::default();
        let clone = clipboard.clone();
        clone.clear_if_ours();
        assert!(Arc::ptr_eq(&clipboard.engine, &clone.engine));
    }
}
