//! Command-layer tests: [`AppState`] driving efre-core with the mock authenticator,
//! with a fake webview, clipboard and clock.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use efre_authn::mock::{MockAuthenticator, MockKeyId};
use efre_authn::{AssertRequest, Assertion, Authenticator, AuthnError, EnrollRequest, Enrollment};
use efre_core::{VaultBuilder, generator};
use secrecy::{ExposeSecret as _, SecretString};
use serde_json::json;

use crate::clipboard::ClipboardError;
use crate::dto::{
    self, AppPhase, FieldKind, FieldRole, ItemKind, KeyInfo, KeyStepEvent, KeyStepKind, LockReason,
    Settings,
};
use crate::error::IpcError;
use crate::hardening::Hardening;
use crate::lock::Clock;
use crate::lock::tests::ManualClock;
use crate::paths::tests::TempDir;
use crate::paths::{self, VaultPaths};
use crate::security::Monitor;
use crate::state::{AppState, Environment, SecretClipboard, lock_reason_for};
use crate::system_events::SystemEvent;
use crate::ui::Ui;

// ------------------------------------------------------------------ fakes

type Hook = Box<dyn Fn(&KeyStepEvent) + Send>;

/// Everything the fake webview was told.
#[derive(Default)]
struct UiLog {
    steps: Mutex<Vec<KeyStepEvent>>,
    locks: Mutex<Vec<LockReason>>,
    /// Runs on each key step: plays the user swapping keys during a prompt.
    hook: Mutex<Option<Hook>>,
}

struct FakeUi(Arc<UiLog>);

impl Ui for FakeUi {
    fn key_step(&self, step: &KeyStepEvent) {
        self.0.steps.lock().unwrap().push(step.clone());
        if let Some(hook) = self.0.hook.lock().unwrap().as_ref() {
            hook(step);
        }
    }

    fn locked(&self, reason: LockReason) {
        self.0.locks.lock().unwrap().push(reason);
    }
}

#[derive(Default)]
struct ClipLog {
    copies: Mutex<Vec<(String, Duration)>>,
    clears: AtomicUsize,
    fail: AtomicBool,
}

struct FakeClipboard(Arc<ClipLog>);

impl SecretClipboard for FakeClipboard {
    fn copy_secret(
        &self,
        value: &SecretString,
        clear_after: Duration,
    ) -> Result<(), ClipboardError> {
        if self.0.fail.load(Ordering::SeqCst) {
            return Err(ClipboardError::Unavailable);
        }
        self.0
            .copies
            .lock()
            .unwrap()
            .push((value.expose_secret().to_owned(), clear_after));
        Ok(())
    }

    fn clear_if_ours(&self) {
        self.0.clears.fetch_add(1, Ordering::SeqCst);
    }
}

fn fakes() -> (Box<dyn SecretClipboard>, Box<dyn Ui>, Box<dyn Clock>) {
    (
        Box::new(FakeClipboard(Arc::default())),
        Box::new(FakeUi(Arc::default())),
        Box::new(ManualClock::default()),
    )
}

fn state_with(
    authenticator: Result<Arc<dyn Authenticator>, String>,
    paths: &VaultPaths,
) -> AppState {
    let (clipboard, ui, clock) = fakes();
    AppState::new(
        Environment {
            authenticator,
            api_version: Some(9),
            paths: Ok(paths.clone()),
            hardening: Hardening::applied(),
        },
        clipboard,
        ui,
        clock,
    )
}

/// Holds one assertion "prompt" open until it is cancelled, like the Windows
/// Security dialog does.
struct BlockingPrompt {
    inner: Arc<MockAuthenticator>,
    armed: AtomicBool,
    /// (prompt open, cancelled)
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}

impl BlockingPrompt {
    fn new(inner: Arc<MockAuthenticator>) -> Self {
        Self {
            inner,
            armed: AtomicBool::new(false),
            state: Mutex::new((false, false)),
            changed: Condvar::new(),
        }
    }

    fn wait_until_open(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.0 {
            state = self.changed.wait(state).unwrap();
        }
    }
}

impl Authenticator for BlockingPrompt {
    fn enroll(&self, request: &EnrollRequest<'_>) -> Result<Enrollment, AuthnError> {
        self.inner.enroll(request)
    }

    fn assert(&self, request: &AssertRequest<'_>) -> Result<Assertion, AuthnError> {
        if !self.armed.swap(false, Ordering::SeqCst) {
            return self.inner.assert(request);
        }
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self.changed.wait(state).unwrap();
        }
        *state = (false, false);
        Err(AuthnError::Cancelled)
    }

    fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        if state.0 {
            state.1 = true;
            self.changed.notify_all();
        }
    }
}

// ---------------------------------------------------------------- harness

struct Harness {
    state: Arc<AppState>,
    mock: Arc<MockAuthenticator>,
    primary: MockKeyId,
    backup: MockKeyId,
    ui: Arc<UiLog>,
    clip: Arc<ClipLog>,
    clock: ManualClock,
    paths: VaultPaths,
    // Last: the vault is closed before its folder is removed.
    _dir: TempDir,
}

impl Harness {
    /// First run: no vault yet.
    fn new() -> Self {
        Self::with_authenticator(|mock| mock)
    }

    fn with_authenticator(
        wrap: impl FnOnce(Arc<MockAuthenticator>) -> Arc<dyn Authenticator>,
    ) -> Self {
        let mock = Arc::new(MockAuthenticator::new());
        let primary = mock.add_key("primary");
        let backup = mock.add_key("backup");
        mock.insert(primary);
        let dir = TempDir::new();
        let paths = paths::prepare(dir.path()).unwrap();
        let ui = Arc::new(UiLog::default());
        let clip = Arc::new(ClipLog::default());
        let clock = ManualClock::default();
        let state = Arc::new(AppState::new(
            Environment {
                authenticator: Ok(wrap(Arc::clone(&mock))),
                api_version: Some(9),
                paths: Ok(paths.clone()),
                hardening: Hardening::applied(),
            },
            Box::new(FakeClipboard(Arc::clone(&clip))),
            Box::new(FakeUi(Arc::clone(&ui))),
            Box::new(clock.clone()),
        ));
        Self {
            state,
            mock,
            primary,
            backup,
            ui,
            clip,
            clock,
            paths,
            _dir: dir,
        }
    }

    /// After the wizard: "Primary" and "Backup" enrolled, the vault unlocked.
    fn unlocked() -> Self {
        let h = Self::new();
        h.run_wizard();
        h
    }

    fn run_wizard(&self) {
        let e = self.epoch();
        self.state.setup_start(e).unwrap();
        self.mock.insert(self.primary);
        self.state.setup_enroll_key(e, "Primary").unwrap();
        self.mock.insert(self.backup);
        self.state.setup_enroll_key(e, "Backup").unwrap();
        assert_eq!(
            self.state.setup_finish(e).unwrap().phase,
            AppPhase::Unlocked
        );
        self.mock.insert(self.primary);
        self.steps();
    }

    fn epoch(&self) -> u64 {
        self.state.triggers.epoch()
    }

    fn phase(&self) -> AppPhase {
        self.state.app_status().phase
    }

    /// The key steps so far (and forgets them).
    fn steps(&self) -> Vec<KeyStepEvent> {
        std::mem::take(&mut *self.ui.steps.lock().unwrap())
    }

    /// The `locked` notifications so far (and forgets them).
    fn locks(&self) -> Vec<LockReason> {
        std::mem::take(&mut *self.ui.locks.lock().unwrap())
    }

    fn copies(&self) -> Vec<(String, Duration)> {
        self.clip.copies.lock().unwrap().clone()
    }

    fn clears(&self) -> usize {
        self.clip.clears.load(Ordering::SeqCst)
    }

    fn on_step(&self, hook: impl Fn(&KeyStepEvent) + Send + 'static) {
        *self.ui.hook.lock().unwrap() = Some(Box::new(hook));
    }

    /// Plugs in the key a rotation step names.
    fn insert_named_keys(&self) {
        let (mock, primary, backup) = (Arc::clone(&self.mock), self.primary, self.backup);
        self.on_step(move |step| match step.nickname.as_deref() {
            Some("Primary") => mock.insert(primary),
            Some("Backup") => mock.insert(backup),
            _ => {}
        });
    }
}

fn code<T: std::fmt::Debug>(result: Result<T, IpcError>) -> &'static str {
    result.unwrap_err().code
}

fn names(keys: &[KeyInfo]) -> Vec<&str> {
    keys.iter().map(|k| k.nickname.as_str()).collect()
}

fn kinds(steps: &[KeyStepEvent]) -> Vec<KeyStepKind> {
    steps.iter().map(|s| s.step).collect()
}

fn use_key(nickname: &str) -> KeyStepEvent {
    KeyStepEvent {
        step: KeyStepKind::UseKey,
        nickname: Some(nickname.to_owned()),
    }
}

fn draft(value: serde_json::Value) -> dto::ItemDraft {
    serde_json::from_value(value).unwrap()
}

fn login_draft() -> dto::ItemDraft {
    draft(json!({
        "kind": "login",
        "title": "Mail",
        "favorite": false,
        "tags": ["work"],
        "fields": [
            { "id": null, "label": "Username", "kind": "text", "role": "username", "value": { "set": "alice" } },
            { "id": null, "label": "Password", "kind": "hidden", "role": "password", "value": { "set": "s3cret" } },
            { "id": null, "label": "Website", "kind": "url", "role": "url", "value": { "set": "https://example.com" } },
        ],
    }))
}

fn note_draft() -> dto::ItemDraft {
    draft(json!({
        "kind": "secureNote",
        "title": "Note",
        "favorite": false,
        "tags": [],
        "fields": [
            { "id": null, "label": "Note", "kind": "multiline", "role": "notes", "value": { "set": "# hi" } },
        ],
    }))
}

fn password_options(length: usize) -> dto::PasswordOptions {
    dto::PasswordOptions {
        length,
        lowercase: true,
        uppercase: true,
        digits: true,
        symbols: true,
        avoid_ambiguous: false,
    }
}

fn passphrase_options(words: usize) -> dto::PassphraseOptions {
    dto::PassphraseOptions {
        words,
        separator: "-".into(),
        capitalize: false,
        include_number: false,
    }
}

// ------------------------------------------------------------------ setup

#[test]
fn first_run_wizard_with_two_keys() {
    let h = Harness::new();
    let status = h.state.app_status();
    assert_eq!(status.phase, AppPhase::Setup);
    assert!(status.keys.is_empty() && status.setup_keys.is_empty());
    assert!(!status.single_key_warning);
    assert_eq!(status.api_version, Some(9));
    assert_eq!(status.unsupported_reason, None);
    assert_eq!(status.last_lock_reason, None);
    assert_eq!(status.vault_path, h.paths.vault.display().to_string());

    let e = h.epoch();
    assert_eq!(
        code(h.state.setup_enroll_key(e, "Primary")),
        "invalid",
        "not started"
    );
    assert_eq!(code(h.state.setup_finish(e)), "invalid", "not started");
    h.state.setup_start(e).unwrap();
    assert_eq!(code(h.state.setup_finish(e)), "invalid", "no key yet");

    let primary = h.state.setup_enroll_key(e, "Primary").unwrap();
    assert_eq!(primary.nickname, "Primary");
    assert_eq!(primary.id.len(), 32);
    assert_eq!(primary.aaguid.len(), 36);
    assert_eq!(
        kinds(&h.steps()),
        [KeyStepKind::CreateCredential, KeyStepKind::ConfirmNewKey]
    );
    assert_eq!(
        code(h.state.setup_enroll_key(e, "Again")),
        "authn.alreadyEnrolled"
    );
    assert_eq!(code(h.state.setup_enroll_key(e, "")), "invalid");
    h.mock.insert(h.backup);
    h.state.setup_enroll_key(e, "Backup").unwrap();

    let status = h.state.app_status();
    assert_eq!(status.phase, AppPhase::Setup);
    assert_eq!(names(&status.setup_keys), ["Primary", "Backup"]);
    assert!(status.keys.is_empty());
    assert!(
        !h.paths.vault.exists(),
        "nothing is written before finishing"
    );

    let status = h.state.setup_finish(e).unwrap();
    assert_eq!(status.phase, AppPhase::Unlocked);
    assert_eq!(names(&status.keys), ["Primary", "Backup"]);
    assert!(status.setup_keys.is_empty());
    assert!(!status.single_key_warning);
    assert!(h.paths.vault.exists());
    assert_eq!(code(h.state.setup_start(e)), "invalid", "setup is over");
}

#[test]
fn a_single_key_vault_shows_the_backup_banner_until_a_second_key() {
    let h = Harness::new();
    let e = h.epoch();
    h.state.setup_start(e).unwrap();
    h.state.setup_enroll_key(e, "Only").unwrap();
    assert!(h.state.setup_finish(e).unwrap().single_key_warning);
    assert!(h.state.app_status().single_key_warning);

    let (mock, backup) = (Arc::clone(&h.mock), h.backup);
    h.on_step(move |step| {
        if step.step == KeyStepKind::CreateCredential {
            mock.insert(backup);
        }
    });
    h.state.add_key(e, "Backup").unwrap();
    assert!(!h.state.app_status().single_key_warning);
}

#[test]
fn cancelling_setup_discards_the_wizard() {
    let h = Harness::new();
    let e = h.epoch();
    h.state.setup_start(e).unwrap();
    h.state.setup_enroll_key(e, "Primary").unwrap();
    let status = h.state.setup_cancel(e).unwrap();
    assert_eq!(status.phase, AppPhase::Setup);
    assert!(status.setup_keys.is_empty());
    assert_eq!(code(h.state.setup_enroll_key(e, "Primary")), "invalid");
    // A fresh run: nothing was stored on the key, so it enrolls again.
    h.state.setup_start(e).unwrap();
    h.state.setup_enroll_key(e, "Primary").unwrap();
    // Starting again also starts over.
    assert!(h.state.setup_start(e).unwrap().setup_keys.is_empty());
}

// ---------------------------------------------------------- unlock / lock

#[test]
fn unlock_with_either_key_and_every_outcome() {
    let h = Harness::unlocked();
    h.state.lock();
    assert_eq!(h.locks(), [LockReason::Manual]);
    let status = h.state.app_status();
    assert_eq!(status.phase, AppPhase::Locked);
    assert_eq!(status.last_lock_reason, Some(LockReason::Manual));
    assert_eq!(
        names(&status.keys),
        ["Primary", "Backup"],
        "named while locked"
    );

    for key in [h.primary, h.backup] {
        h.mock.insert(key);
        assert_eq!(h.state.unlock(h.epoch()).unwrap().phase, AppPhase::Unlocked);
        assert_eq!(kinds(&h.steps()), [KeyStepKind::UseEnrolledKey]);
        assert_eq!(
            code(h.state.unlock(h.epoch())),
            "invalid",
            "already unlocked"
        );
        h.state.lock();
    }

    h.mock.unplug();
    assert_eq!(code(h.state.unlock(h.epoch())), "authn.noDevice");
    let stranger = h.mock.add_key("stranger");
    h.mock.insert(stranger);
    assert_eq!(code(h.state.unlock(h.epoch())), "authn.unknownKey");
    h.mock.insert(h.primary);
    for (error, expected) in [
        (AuthnError::Cancelled, "authn.cancelled"),
        (AuthnError::Timeout, "authn.timeout"),
        (AuthnError::WrongPin, "authn.wrongPin"),
        (AuthnError::PinBlocked, "authn.pinBlocked"),
    ] {
        h.mock.fail_next(error);
        assert_eq!(code(h.state.unlock(h.epoch())), expected);
    }
    assert_eq!(h.phase(), AppPhase::Locked);
}

#[test]
fn locking_a_locked_vault_still_reloads_but_wipes_nothing() {
    let h = Harness::unlocked();
    h.state.lock();
    let epoch = h.epoch();
    h.locks();
    h.state.lock();
    assert_eq!(h.locks(), [LockReason::Manual], "the webview reloads");
    assert_eq!(h.epoch(), epoch, "nothing was wiped");
    // Automatic triggers stay quiet when there is nothing to lock.
    assert!(!h.state.lock_now(LockReason::Session));
    assert!(h.locks().is_empty());
}

#[test]
fn commands_outside_their_phase() {
    let h = Harness::new();
    let e = h.epoch();
    assert_eq!(code(h.state.list_items(e)), "locked");
    assert_eq!(code(h.state.get_settings(e)), "locked");
    assert_eq!(code(h.state.unlock(e)), "invalid");

    let h = Harness::unlocked();
    let e = h.epoch();
    assert_eq!(code(h.state.setup_start(e)), "invalid");
    assert_eq!(code(h.state.setup_cancel(e)), "invalid");
    assert_eq!(code(h.state.setup_finish(e)), "invalid");

    h.state.lock();
    let e = h.epoch();
    let id = "ab".repeat(16);
    for result in [
        code(h.state.list_items(e)),
        code(h.state.get_item(e, &id)),
        code(h.state.create_item(e, login_draft())),
        code(h.state.reveal_field(e, &id, 1)),
        code(h.state.copy_field(e, &id, 1)),
        code(h.state.copy_role(e, &id, FieldRole::Password)),
        code(h.state.empty_trash(e)),
        code(h.state.generate_password(e, password_options(20))),
        code(h.state.generate_passphrase(e, passphrase_options(6))),
        code(h.state.copy_generated(e)),
        code(h.state.get_settings(e)),
        code(h.state.list_keys(e)),
        code(h.state.add_key(e, "Third")),
        code(h.state.rename_key(e, &"00".repeat(16), "x")),
        code(h.state.remove_key(e, &"00".repeat(16))),
    ] {
        assert_eq!(result, "locked");
    }
}

#[test]
fn commands_sent_before_a_lock_are_refused_after_it() {
    let h = Harness::unlocked();
    let stale = h.epoch();
    h.state.lock();
    h.state.unlock(h.epoch()).unwrap();
    assert_eq!(code(h.state.list_items(stale)), "locked");
    assert_eq!(code(h.state.create_item(stale, login_draft())), "locked");
    assert_eq!(code(h.state.unlock(stale)), "locked");
    assert!(h.state.list_items(h.epoch()).unwrap().is_empty());
}

// ------------------------------------------------------------------ items

#[test]
fn items_keep_secrets_out_of_views() {
    let h = Harness::unlocked();
    let e = h.epoch();
    let meta = h.state.create_item(e, login_draft()).unwrap();
    assert_eq!(meta.kind, ItemKind::Login);
    assert_eq!(meta.title.as_str(), "Mail");
    assert_eq!(
        meta.username.as_ref().map(dto::WebText::as_str),
        Some("alice")
    );
    assert!(meta.has_password && !meta.favorite && meta.trashed_at.is_none());
    let list = h.state.list_items(e).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, meta.id);

    let view = h.state.get_item(e, &meta.id).unwrap();
    let password = view
        .fields
        .iter()
        .find(|f| f.role == Some(FieldRole::Password))
        .unwrap();
    assert_eq!(password.kind, FieldKind::Hidden);
    assert!(password.value.is_none(), "secret withheld");
    let json = serde_json::to_string(&view).unwrap();
    assert!(!json.contains("s3cret"), "{json}");
    let url = view
        .fields
        .iter()
        .find(|f| f.role == Some(FieldRole::Url))
        .unwrap();
    assert_eq!(
        url.value.as_ref().map(dto::WebText::as_str),
        Some("https://example.com")
    );

    // The explicit reveal.
    let password_id = password.id;
    assert_eq!(
        h.state
            .reveal_field(e, &meta.id, password_id)
            .unwrap()
            .as_str(),
        "s3cret"
    );
    assert_eq!(code(h.state.reveal_field(e, &meta.id, 99)), "notFound");

    // Editing never needs the secret: "keep" leaves it as it was.
    let edit = draft(json!({
        "kind": "login", "title": "Mail (work)", "favorite": true, "tags": [],
        "fields": [
            { "id": password_id, "label": "Password", "kind": "hidden", "role": "password", "value": "keep" },
        ],
    }));
    let updated = h.state.update_item(e, &meta.id, edit).unwrap();
    assert_eq!(updated.title.as_str(), "Mail (work)");
    assert!(updated.favorite && updated.username.is_none());
    assert_eq!(
        h.state
            .reveal_field(e, &meta.id, password_id)
            .unwrap()
            .as_str(),
        "s3cret"
    );

    assert!(!h.state.set_favorite(e, &meta.id, false).unwrap().favorite);
    assert_eq!(code(h.state.delete_item(e, &meta.id)), "vault.notInTrash");
    assert!(
        h.state
            .trash_item(e, &meta.id)
            .unwrap()
            .trashed_at
            .is_some()
    );
    assert!(
        h.state.list_items(e).unwrap()[0].trashed_at.is_some(),
        "trash is listed"
    );
    assert!(
        h.state
            .restore_item(e, &meta.id)
            .unwrap()
            .trashed_at
            .is_none()
    );
    h.state.trash_item(e, &meta.id).unwrap();
    h.state.delete_item(e, &meta.id).unwrap();
    assert_eq!(code(h.state.get_item(e, &meta.id)), "notFound");

    let a = h.state.create_item(e, login_draft()).unwrap();
    let b = h.state.create_item(e, note_draft()).unwrap();
    h.state.trash_item(e, &a.id).unwrap();
    h.state.trash_item(e, &b.id).unwrap();
    assert_eq!(h.state.empty_trash(e).unwrap(), 2);
    assert_eq!(h.state.empty_trash(e).unwrap(), 0);
    assert!(h.state.list_items(e).unwrap().is_empty());

    assert_eq!(code(h.state.get_item(e, "nope")), "invalid");
    assert_eq!(code(h.state.get_item(e, &"AB".repeat(16))), "invalid");
    assert_eq!(code(h.state.get_item(e, &"ab".repeat(16))), "notFound");
    let untitled = draft(json!({
        "kind": "login", "title": "", "favorite": false, "tags": [], "fields": [],
    }));
    assert_eq!(code(h.state.create_item(e, untitled)), "invalid");
}

#[test]
fn copying_happens_in_rust_with_the_vault_timer() {
    let h = Harness::unlocked();
    let e = h.epoch();
    let meta = h.state.create_item(e, login_draft()).unwrap();
    let copied = h.state.copy_role(e, &meta.id, FieldRole::Password).unwrap();
    assert_eq!(copied.clears_in_seconds, 30);

    let settings = Settings {
        auto_lock_minutes: 10,
        clipboard_clear_seconds: 45,
    };
    assert_eq!(h.state.set_settings(e, settings).unwrap(), settings);
    assert_eq!(h.state.get_settings(e).unwrap(), settings);
    let view = h.state.get_item(e, &meta.id).unwrap();
    let username = view
        .fields
        .iter()
        .find(|f| f.role == Some(FieldRole::Username))
        .unwrap();
    assert_eq!(
        h.state
            .copy_field(e, &meta.id, username.id)
            .unwrap()
            .clears_in_seconds,
        45
    );
    assert_eq!(
        h.copies(),
        [
            ("s3cret".to_owned(), Duration::from_secs(30)),
            ("alice".to_owned(), Duration::from_secs(45)),
        ]
    );

    let note = h.state.create_item(e, note_draft()).unwrap();
    assert_eq!(
        code(h.state.copy_role(e, &note.id, FieldRole::Password)),
        "notFound"
    );
    for bad in [
        Settings {
            auto_lock_minutes: 0,
            clipboard_clear_seconds: 45,
        },
        Settings {
            auto_lock_minutes: 121,
            clipboard_clear_seconds: 45,
        },
        Settings {
            auto_lock_minutes: 5,
            clipboard_clear_seconds: 4,
        },
        Settings {
            auto_lock_minutes: 5,
            clipboard_clear_seconds: 301,
        },
    ] {
        assert_eq!(code(h.state.set_settings(e, bad)), "invalid", "{bad:?}");
    }
    assert_eq!(h.state.get_settings(e).unwrap(), settings);

    h.clip.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        code(h.state.copy_role(e, &meta.id, FieldRole::Password)),
        "clipboard"
    );

    let clears = h.clears();
    h.state.lock();
    assert_eq!(
        h.clears(),
        clears + 1,
        "a lock clears efre's clipboard value"
    );
}

#[test]
fn generated_values_stay_in_rust_until_copied() {
    let h = Harness::unlocked();
    let e = h.epoch();
    assert_eq!(code(h.state.copy_generated(e)), "notFound");
    assert_eq!(
        code(h.state.generate_password(e, password_options(7))),
        "invalid"
    );
    assert_eq!(
        code(h.state.generate_passphrase(e, passphrase_options(2))),
        "invalid"
    );

    let shown = h.state.remember_generated(generator::Generated {
        value: SecretString::from("correct-horse-battery"),
        entropy_bits: 77.5,
    });
    assert_eq!(shown.value.as_str(), "correct-horse-battery");
    assert_eq!(h.state.copy_generated(e).unwrap().clears_in_seconds, 30);
    assert_eq!(h.copies().last().unwrap().0, "correct-horse-battery");

    // A lock wipes it.
    h.state.lock();
    h.state.unlock(h.epoch()).unwrap();
    assert_eq!(code(h.state.copy_generated(h.epoch())), "notFound");
}

// ------------------------------------------------------------------- keys

#[test]
fn key_management_prompts_with_key_steps() {
    let h = Harness::unlocked();
    let e = h.epoch();

    // Add: an enrolled key, then the new key twice.
    let third = h.mock.add_key("third");
    let mock = Arc::clone(&h.mock);
    h.on_step(move |step| {
        if step.step == KeyStepKind::CreateCredential {
            mock.insert(third);
        }
    });
    let added = h.state.add_key(e, "Third").unwrap();
    assert_eq!(added.nickname, "Third");
    assert_eq!(
        kinds(&h.steps()),
        [
            KeyStepKind::UseEnrolledKey,
            KeyStepKind::CreateCredential,
            KeyStepKind::ConfirmNewKey
        ]
    );
    assert_eq!(
        names(&h.state.list_keys(e).unwrap()),
        ["Primary", "Backup", "Third"]
    );

    // Rename: one prompt on any enrolled key.
    *h.ui.hook.lock().unwrap() = None;
    h.mock.insert(h.primary);
    assert_eq!(
        h.state.rename_key(e, &added.id, "Spare").unwrap().nickname,
        "Spare"
    );
    assert_eq!(kinds(&h.steps()), [KeyStepKind::UseEnrolledKey]);
    assert_eq!(code(h.state.rename_key(e, &added.id, "")), "invalid");
    assert_eq!(
        code(h.state.rename_key(e, &"cd".repeat(16), "x")),
        "notFound"
    );
    assert_eq!(code(h.state.rename_key(e, "cd", "x")), "invalid");
    h.steps();

    // Remove: one prompt per remaining key, each by name.
    h.insert_named_keys();
    let remaining = h.state.remove_key(e, &added.id).unwrap();
    assert_eq!(names(&remaining), ["Primary", "Backup"]);
    assert_eq!(h.steps(), [use_key("Primary"), use_key("Backup")]);

    // The removed key opens nothing any more.
    h.state.lock();
    h.mock.insert(third);
    assert_eq!(code(h.state.unlock(h.epoch())), "authn.unknownKey");
    h.mock.insert(h.primary);
    h.state.unlock(h.epoch()).unwrap();

    // The last key can't be removed.
    let e = h.epoch();
    let keys = h.state.list_keys(e).unwrap();
    h.state.remove_key(e, &keys[1].id).unwrap();
    assert!(h.state.app_status().single_key_warning);
    assert_eq!(code(h.state.remove_key(e, &keys[0].id)), "vault.lastKey");
}

// ---------------------------------------------------------- lock triggers

#[test]
fn unplugging_locks_an_unlocked_vault() {
    let h = Harness::unlocked();
    h.state.on_presence(false);
    assert_eq!(h.state.run_lock_requests(), 1);
    assert_eq!(h.phase(), AppPhase::Locked);
    assert_eq!(h.locks(), [LockReason::Unplug]);
    assert_eq!(
        h.state.app_status().last_lock_reason,
        Some(LockReason::Unplug)
    );
    // Locked: nothing more to do.
    h.state.on_presence(true);
    h.state.on_presence(false);
    assert_eq!(h.state.run_lock_requests(), 0);
}

#[test]
fn unplug_is_suspended_while_swapping_keys() {
    let h = Harness::unlocked();
    let third = h.mock.add_key("third");
    let (state, mock) = (Arc::downgrade(&h.state), Arc::clone(&h.mock));
    h.on_step(move |step| {
        if step.step == KeyStepKind::CreateCredential {
            // One USB port: out with the enrolled key, in with the new one.
            let state = state.upgrade().unwrap();
            state.on_presence(false);
            mock.insert(third);
            state.on_presence(true);
        }
    });
    h.state.add_key(h.epoch(), "Third").unwrap();
    assert_eq!(h.state.run_lock_requests(), 0);
    assert_eq!(h.phase(), AppPhase::Unlocked);
}

#[test]
fn a_key_flow_that_ends_with_no_yubikey_locks_at_once() {
    let h = Harness::unlocked();
    let third = h.mock.add_key("third");
    let (state, mock) = (Arc::downgrade(&h.state), Arc::clone(&h.mock));
    h.on_step(move |step| {
        if step.step == KeyStepKind::CreateCredential {
            state.upgrade().unwrap().on_presence(false);
            mock.insert(third);
        }
    });
    // The flow completes; no YubiKey is reported when it ends.
    h.state.add_key(h.epoch(), "Third").unwrap();
    assert_eq!(h.state.run_lock_requests(), 1);
    assert_eq!(h.phase(), AppPhase::Locked);
    assert_eq!(h.locks(), [LockReason::Unplug]);
}

#[test]
fn unplugging_during_other_prompts_still_locks() {
    let h = Harness::unlocked();
    let id = h.state.list_keys(h.epoch()).unwrap()[0].id.clone();
    let state = Arc::downgrade(&h.state);
    // Renaming is not a key-swapping flow.
    h.on_step(move |_| state.upgrade().unwrap().on_presence(false));
    h.state.rename_key(h.epoch(), &id, "Renamed").unwrap();
    assert_eq!(h.state.run_lock_requests(), 1);
    assert_eq!(h.phase(), AppPhase::Locked);
}

#[test]
fn unplugging_between_wizard_keys_keeps_the_wizard() {
    let h = Harness::new();
    let e = h.epoch();
    h.state.setup_start(e).unwrap();
    h.state.setup_enroll_key(e, "Primary").unwrap();
    h.state.on_presence(false);
    h.mock.insert(h.backup);
    h.state.setup_enroll_key(e, "Backup").unwrap();
    assert_eq!(h.state.run_lock_requests(), 0);
    assert_eq!(
        names(&h.state.app_status().setup_keys),
        ["Primary", "Backup"]
    );
    assert!(h.locks().is_empty());
}

#[test]
fn idle_locks_after_the_vault_setting() {
    let h = Harness::unlocked();
    let e = h.epoch();
    let settings = Settings {
        auto_lock_minutes: 2,
        clipboard_clear_seconds: 30,
    };
    h.state.set_settings(e, settings).unwrap();
    h.clock.advance_secs(119);
    h.state.check_idle();
    assert_eq!(h.phase(), AppPhase::Unlocked);
    h.state.triggers.touch(); // the `activity` command
    h.clock.advance_secs(119);
    h.state.check_idle();
    assert_eq!(h.phase(), AppPhase::Unlocked);
    h.clock.advance_secs(1);
    h.state.check_idle();
    assert_eq!(h.phase(), AppPhase::Locked);
    assert_eq!(h.locks(), [LockReason::Idle]);

    h.clock.advance_secs(3600);
    h.state.check_idle();
    assert!(h.locks().is_empty(), "nothing left to lock");

    // Unlocking restarts the deadline, with the stored setting.
    h.state.unlock(h.epoch()).unwrap();
    h.clock.advance_secs(119);
    h.state.check_idle();
    assert_eq!(h.phase(), AppPhase::Unlocked);
    h.clock.advance_secs(1);
    h.state.check_idle();
    assert_eq!(h.phase(), AppPhase::Locked);
}

#[test]
fn idle_and_system_events_during_setup_discard_the_wizard() {
    let h = Harness::new();
    h.state.setup_start(h.epoch()).unwrap();
    h.state.setup_enroll_key(h.epoch(), "Primary").unwrap();
    h.clock.advance_secs(5 * 60);
    h.state.check_idle();
    assert_eq!(h.locks(), [LockReason::Idle]);
    let status = h.state.app_status();
    assert_eq!(status.phase, AppPhase::Setup);
    assert!(
        status.setup_keys.is_empty(),
        "the builder and its VMK are gone"
    );
    assert_eq!(
        code(h.state.setup_enroll_key(h.epoch(), "Primary")),
        "invalid"
    );

    for event in [
        SystemEvent::Suspend,
        SystemEvent::SessionLocked,
        SystemEvent::SessionDisconnected,
        SystemEvent::LoggingOff,
    ] {
        h.state.setup_start(h.epoch()).unwrap();
        assert!(h.state.lock_now(lock_reason_for(event)));
        assert!(h.state.app_status().setup_keys.is_empty());
    }
    assert_eq!(
        h.locks(),
        [
            LockReason::Suspend,
            LockReason::Session,
            LockReason::Session,
            LockReason::Session
        ]
    );
}

#[test]
fn system_events_lock_through_the_worker_before_returning() {
    let h = Harness::unlocked();
    h.state.spawn_lock_worker().unwrap();
    assert!(h.state.spawn_lock_worker().is_err(), "one worker only");
    h.state.on_system_event(SystemEvent::SessionLocked);
    assert_eq!(h.phase(), AppPhase::Locked);
    assert_eq!(h.locks(), [LockReason::Session]);
}

#[test]
fn a_lock_cancels_the_open_prompt_first() {
    let mut blocking = None;
    let h = Harness::with_authenticator(|mock| {
        let prompt = Arc::new(BlockingPrompt::new(mock));
        blocking = Some(Arc::clone(&prompt));
        prompt
    });
    let blocking = blocking.unwrap();
    h.run_wizard();
    let id = h.state.list_keys(h.epoch()).unwrap()[0].id.clone();

    // cancel_prompt closes the prompt; the vault stays unlocked.
    blocking.armed.store(true, Ordering::SeqCst);
    let (state, e, key) = (Arc::clone(&h.state), h.epoch(), id.clone());
    let renaming = thread::spawn(move || state.rename_key(e, &key, "Renamed").map(|k| k.nickname));
    blocking.wait_until_open();
    h.state.cancel_prompt();
    assert_eq!(
        renaming.join().unwrap().unwrap_err().code,
        "authn.cancelled"
    );
    assert_eq!(h.phase(), AppPhase::Unlocked);

    // A prompt holds the vault mutex: the lock must cancel it, not wait for it.
    blocking.armed.store(true, Ordering::SeqCst);
    let (state, e) = (Arc::clone(&h.state), h.epoch());
    let renaming = thread::spawn(move || state.rename_key(e, &id, "Renamed").map(|k| k.nickname));
    blocking.wait_until_open();
    let (done, finished) = mpsc::channel();
    let state = Arc::clone(&h.state);
    thread::spawn(move || {
        let _ = done.send(state.lock_now(LockReason::Session));
    });
    let wiped = finished
        .recv_timeout(Duration::from_secs(10))
        .expect("the lock waited for the prompt instead of cancelling it");
    assert!(wiped);
    assert_eq!(
        renaming.join().unwrap().unwrap_err().code,
        "authn.cancelled"
    );
    assert_eq!(h.phase(), AppPhase::Locked);
    assert_eq!(h.locks(), [LockReason::Session]);
}

#[test]
fn system_events_map_to_lock_reasons() {
    assert_eq!(lock_reason_for(SystemEvent::Suspend), LockReason::Suspend);
    for event in [
        SystemEvent::SessionLocked,
        SystemEvent::SessionDisconnected,
        SystemEvent::LoggingOff,
    ] {
        assert_eq!(lock_reason_for(event), LockReason::Session);
    }
}

// --------------------------------------------------- environment, startup

#[test]
fn an_unusable_windows_is_unsupported() {
    let dir = TempDir::new();
    let paths = paths::prepare(dir.path()).unwrap();
    let state = state_with(Err("Update Windows.".into()), &paths);
    let status = state.app_status();
    assert_eq!(status.phase, AppPhase::Unsupported);
    assert_eq!(
        status.unsupported_reason.as_deref(),
        Some("Update Windows.")
    );
    assert_eq!(code(state.setup_start(0)), "invalid");
    assert_eq!(code(state.unlock(0)), "invalid");
    assert_eq!(code(state.list_items(0)), "locked");
    assert_eq!(state.security_info().key_count, 0);
}

#[test]
fn a_vault_file_that_cannot_be_opened_is_never_replaced() {
    let dir = TempDir::new();
    let paths = paths::prepare(dir.path()).unwrap();
    std::fs::write(&paths.vault, b"definitely not a vault").unwrap();
    let mock: Arc<dyn Authenticator> = Arc::new(MockAuthenticator::new());
    let state = state_with(Ok(mock), &paths);
    let status = state.app_status();
    assert_eq!(status.phase, AppPhase::Unsupported);
    let reason = status.unsupported_reason.unwrap();
    assert!(
        reason.starts_with("efre can't open the vault file:"),
        "{reason}"
    );
    assert_eq!(code(state.setup_start(0)), "invalid");
    assert_eq!(code(state.unlock(0)), "invalid");
    assert_eq!(
        std::fs::read(&paths.vault).unwrap(),
        b"definitely not a vault"
    );
}

#[test]
fn app_status_finds_a_vault_that_appeared() {
    let h = Harness::new();
    assert_eq!(h.phase(), AppPhase::Setup);
    // A copy restored into the folder while efre was on the welcome screen.
    let mut builder = VaultBuilder::new().unwrap();
    builder
        .enroll_key(&*h.mock, "Primary", &mut |_| {})
        .unwrap();
    drop(builder.create(&h.paths.vault).unwrap());
    assert_eq!(h.phase(), AppPhase::Locked);
    h.state.unlock(h.epoch()).unwrap();
}

#[test]
fn quitting_closes_the_vault_and_the_next_launch_finds_it_locked() {
    let h = Harness::unlocked();
    h.state.create_item(h.epoch(), login_draft()).unwrap();
    let clears = h.clears();
    h.state.shutdown(true);
    assert!(!h.state.triggers.is_unlocked());
    assert_eq!(h.clears(), clears + 1);
    assert!(h.locks().is_empty(), "quitting doesn't reload the window");
    assert_eq!(h.phase(), AppPhase::Unsupported, "closing");

    let mock: Arc<dyn Authenticator> = h.mock.clone();
    let next = state_with(Ok(mock), &h.paths);
    assert_eq!(next.app_status().phase, AppPhase::Locked);
    next.unlock(0).unwrap();
    assert_eq!(next.list_items(0).unwrap().len(), 1);
}

#[test]
fn security_info_reports_what_is_active() {
    let h = Harness::unlocked();
    let info = h.state.security_info();
    assert_eq!(info.key_count, 2);
    assert_eq!(info.vault_path, h.paths.vault.display().to_string());
    assert_eq!(info.webauthn_api_version, Some(9));
    let limits = info.limits.join("\n");
    assert!(
        limits.contains("unplugged is unavailable: not started"),
        "{limits}"
    );
    h.state.set_presence_monitor(Monitor::Active);
    h.state.set_system_events_monitor(Monitor::Active);
    h.state.set_browser_ui_monitor(Monitor::Active);
    let info = h.state.security_info();
    let protections = info.protections.join("\n");
    assert!(
        protections.contains("no YubiKey is plugged in"),
        "{protections}"
    );
    assert!(
        protections.contains("Windows Error Reporting leaves efre out"),
        "{protections}"
    );
    assert!(!info.limits.join("\n").contains("unavailable"));
}

#[test]
fn security_info_lists_hardening_that_did_not_apply() {
    let dir = TempDir::new();
    let paths = paths::prepare(dir.path()).unwrap();
    let mock: Arc<dyn Authenticator> = Arc::new(MockAuthenticator::new());
    let (clipboard, ui, clock) = fakes();
    let mut hardening = Hardening::applied();
    hardening.crash_reports = Monitor::Unavailable("Windows refused it (0x80004005)".into());
    let state = AppState::new(
        Environment {
            authenticator: Ok(mock),
            api_version: Some(9),
            paths: Ok(paths),
            hardening,
        },
        clipboard,
        ui,
        clock,
    );
    let info = state.security_info();
    let limits = info.limits.join("\n");
    assert!(
        limits.contains(
            "Windows Error Reporting crash reports and dumps is unavailable: Windows refused \
             it (0x80004005)"
        ),
        "{limits}"
    );
    let protections = info.protections.join("\n");
    assert!(
        !protections.contains("Windows Error Reporting leaves efre out"),
        "{protections}"
    );
    assert!(protections.contains("never in the current folder or PATH"));
}

#[cfg(not(windows))]
#[test]
fn opening_the_vault_folder_is_a_no_op_off_windows() {
    let h = Harness::new();
    h.state.open_vault_folder().unwrap();
    h.run_wizard();
    h.state.open_vault_folder().unwrap();
}
