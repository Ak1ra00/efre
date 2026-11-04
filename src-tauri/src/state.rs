//! The app's state and the logic behind every IPC command (docs/IPC.md), independent
//! of Tauri so it can be tested against the mock authenticator.
//!
//! Locking order, to rule out deadlocks: `lock_serial`, then `vault`, then `builder`,
//! then `generated`. A Windows Security prompt runs while holding `vault` (or
//! `builder` during setup), so every lock first cancels the prompt (ARCHITECTURE §6.6).

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError, mpsc};
use std::time::{Duration, Instant};
use std::{fs, io, thread};

use efre_authn::Authenticator;
use efre_core::{
    FieldRole as CoreFieldRole, ItemId, KeyStep, Vault, VaultBuilder, VaultError, generator,
};
use secrecy::{ExposeSecret as _, SecretString};

use crate::clipboard::{Clipboard, ClipboardError};
use crate::dto::{
    self, AppPhase, AppStatus, CopyResult, FieldRole, Generated, ItemMeta, ItemView, KeyInfo,
    KeyStepEvent, LockReason, SecurityInfo, Settings, WebText, item_id, key_infos, slot_id,
};
use crate::error::{IpcError, IpcResult};
use crate::hardening::Hardening;
use crate::lock::{Clock, LockTriggers};
use crate::paths::VaultPaths;
use crate::platform;
use crate::security::{self, Monitor};
use crate::system_events::SystemEvent;
use crate::ui::Ui;

/// How often the lock worker checks the idle deadline.
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// Pause between attempts to take a mutex that a prompt may hold (each one cancels again).
const LOCK_RETRY: Duration = Duration::from_millis(25);
/// How long a suspend or session notification waits for the lock to finish. Windows
/// allows about two seconds for suspend notifications.
const SYSTEM_EVENT_WAIT: Duration = Duration::from_millis(1500);
/// How long quitting waits for a prompt to let go of the vault.
const EXIT_WAIT: Duration = Duration::from_secs(2);

/// The clipboard, behind a trait so tests can observe it.
pub(crate) trait SecretClipboard: Send + Sync {
    fn copy_secret(
        &self,
        value: &SecretString,
        clear_after: Duration,
    ) -> Result<(), ClipboardError>;
    fn clear_if_ours(&self);
}

impl SecretClipboard for Clipboard {
    fn copy_secret(
        &self,
        value: &SecretString,
        clear_after: Duration,
    ) -> Result<(), ClipboardError> {
        Clipboard::copy_secret(self, value, clear_after)
    }

    fn clear_if_ours(&self) {
        Clipboard::clear_if_ours(self);
    }
}

/// What the app found at startup. An `Err` is the user-facing reason efre can't run.
pub(crate) struct Environment {
    pub(crate) authenticator: Result<Arc<dyn Authenticator>, String>,
    pub(crate) api_version: Option<u32>,
    pub(crate) paths: Result<VaultPaths, String>,
    /// What the startup hardening achieved (ARCHITECTURE §8.1).
    pub(crate) hardening: Hardening,
}

enum VaultSlot {
    /// No vault file yet: first-run setup.
    Absent,
    /// The vault file, locked or unlocked.
    Open(Box<Vault>),
    /// A file exists but can't be opened (damaged, not a vault, too new, in use, ...).
    Failed(IpcError),
    /// efre is quitting and has closed the vault.
    Closed,
}

struct LockRequest {
    reason: LockReason,
    /// Signalled once the lock has run.
    done: Option<mpsc::SyncSender<()>>,
}

pub(crate) struct AppState {
    env: Environment,
    vault: Mutex<VaultSlot>,
    /// The wizard's vault-in-progress. It holds the new VMK.
    builder: Mutex<Option<VaultBuilder>>,
    /// The last generated password or passphrase, for `copy_generated`.
    generated: Mutex<Option<SecretString>>,
    last_lock_reason: Mutex<Option<LockReason>>,
    clipboard: Box<dyn SecretClipboard>,
    ui: Box<dyn Ui>,
    pub(crate) triggers: LockTriggers,
    /// Serialises lock procedures.
    lock_serial: Mutex<()>,
    requests: mpsc::Sender<LockRequest>,
    /// The receiving end, until the lock worker takes it.
    request_rx: Mutex<Option<mpsc::Receiver<LockRequest>>>,
    presence: Mutex<Monitor>,
    system_events: Mutex<Monitor>,
    /// The webview's own shortcuts and context menu (print, save as) are off.
    browser_ui: Mutex<Monitor>,
}

fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Takes `mutex`, cancelling any Windows Security prompt between attempts: a prompt
/// holds the vault (or builder) mutex until it returns. Gives up at `deadline`.
fn acquire<'a, T>(
    mutex: &'a Mutex<T>,
    cancel: &dyn Fn(),
    deadline: Option<Instant>,
) -> Option<MutexGuard<'a, T>> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {}
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            return None;
        }
        // A prompt that opened after the previous cancel would otherwise keep the
        // mutex for minutes.
        cancel();
        thread::sleep(LOCK_RETRY);
    }
}

fn probe(path: &Path) -> VaultSlot {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => VaultSlot::Absent,
        _ => match Vault::open(path) {
            Ok(vault) => VaultSlot::Open(Box::new(vault)),
            Err(error) => VaultSlot::Failed(error.into()),
        },
    }
}

fn meta_of(vault: &Vault, id: ItemId) -> IpcResult<ItemMeta> {
    vault
        .items()?
        .into_iter()
        .find(|m| m.id == id)
        .map(ItemMeta::from)
        .ok_or_else(|| VaultError::ItemNotFound.into())
}

/// Suspend locks for "suspend"; Windows lock, disconnect and sign-out for "session".
pub(crate) fn lock_reason_for(event: SystemEvent) -> LockReason {
    match event {
        SystemEvent::Suspend => LockReason::Suspend,
        SystemEvent::SessionLocked | SystemEvent::SessionDisconnected | SystemEvent::LoggingOff => {
            LockReason::Session
        }
    }
}

/// Marks a key flow during which the unplug trigger is suspended (ARCHITECTURE §6.7).
/// Dropping it ends the flow, and asks for a lock if no YubiKey remains.
pub(crate) struct KeyFlow<'a>(&'a AppState);

impl Drop for KeyFlow<'_> {
    fn drop(&mut self) {
        if self.0.triggers.end_flow() {
            self.0.request_lock(LockReason::Unplug);
        }
    }
}

impl AppState {
    pub(crate) fn new(
        env: Environment,
        clipboard: Box<dyn SecretClipboard>,
        ui: Box<dyn Ui>,
        clock: Box<dyn Clock>,
    ) -> Self {
        let slot = match (&env.authenticator, &env.paths) {
            (Ok(_), Ok(paths)) => probe(&paths.vault),
            _ => VaultSlot::Absent,
        };
        let (requests, request_rx) = mpsc::channel();
        let not_started = || Mutex::new(Monitor::Unavailable("not started".to_owned()));
        Self {
            env,
            vault: Mutex::new(slot),
            builder: Mutex::new(None),
            generated: Mutex::new(None),
            last_lock_reason: Mutex::new(None),
            clipboard,
            ui,
            triggers: LockTriggers::new(clock),
            lock_serial: Mutex::new(()),
            requests,
            request_rx: Mutex::new(Some(request_rx)),
            presence: not_started(),
            system_events: not_started(),
            browser_ui: not_started(),
        }
    }

    // ---------------------------------------------------------------- helpers

    fn authn(&self) -> IpcResult<&dyn Authenticator> {
        self.env
            .authenticator
            .as_deref()
            .map_err(|reason| IpcError::invalid(reason.clone()))
    }

    fn paths(&self) -> IpcResult<&VaultPaths> {
        self.env
            .paths
            .as_ref()
            .map_err(|reason| IpcError::invalid(reason.clone()))
    }

    fn cancel_pending_prompt(&self) {
        if let Ok(authn) = &self.env.authenticator {
            authn.cancel();
        }
    }

    /// The vault mutex, for a command that started at `epoch`. A lock since then
    /// (which reloaded the webview that sent the command) makes it fail.
    fn vault_at(&self, epoch: u64) -> IpcResult<MutexGuard<'_, VaultSlot>> {
        let slot = guard(&self.vault);
        if self.triggers.epoch() != epoch {
            return Err(IpcError::locked());
        }
        Ok(slot)
    }

    fn with_unlocked<T>(
        &self,
        epoch: u64,
        f: impl FnOnce(&mut Vault) -> IpcResult<T>,
    ) -> IpcResult<T> {
        let mut slot = self.vault_at(epoch)?;
        match &mut *slot {
            VaultSlot::Open(vault) if vault.is_unlocked() => f(vault),
            _ => Err(IpcError::locked()),
        }
    }

    fn unsupported_reason(&self, slot: &VaultSlot) -> Option<String> {
        if let Err(reason) = &self.env.authenticator {
            return Some(reason.clone());
        }
        if let Err(reason) = &self.env.paths {
            return Some(reason.clone());
        }
        match slot {
            VaultSlot::Failed(error) => {
                Some(format!("efre can't open the vault file: {}", error.message))
            }
            VaultSlot::Closed => Some("efre is closing.".to_owned()),
            VaultSlot::Absent | VaultSlot::Open(_) => None,
        }
    }

    fn phase_of(&self, slot: &VaultSlot) -> AppPhase {
        if self.env.authenticator.is_err() || self.env.paths.is_err() {
            return AppPhase::Unsupported;
        }
        match slot {
            VaultSlot::Absent => AppPhase::Setup,
            VaultSlot::Open(vault) if vault.is_unlocked() => AppPhase::Unlocked,
            VaultSlot::Open(_) => AppPhase::Locked,
            VaultSlot::Failed(_) | VaultSlot::Closed => AppPhase::Unsupported,
        }
    }

    fn vault_path_display(&self) -> String {
        self.env
            .paths
            .as_ref()
            .map(|p| p.vault.display().to_string())
            .unwrap_or_default()
    }

    fn status_of(&self, slot: &VaultSlot, builder: &Option<VaultBuilder>) -> AppStatus {
        let phase = self.phase_of(slot);
        let keys = match slot {
            VaultSlot::Open(vault) => key_infos(&vault.slots()),
            _ => Vec::new(),
        };
        let setup_keys = match (phase, builder) {
            (AppPhase::Setup, Some(builder)) => key_infos(&builder.slots()),
            _ => Vec::new(),
        };
        AppStatus {
            phase,
            api_version: self.env.api_version,
            unsupported_reason: if phase == AppPhase::Unsupported {
                self.unsupported_reason(slot)
            } else {
                None
            },
            single_key_warning: keys.len() == 1,
            keys,
            setup_keys,
            last_lock_reason: *guard(&self.last_lock_reason),
            vault_path: self.vault_path_display(),
        }
    }

    /// Progress from efre-core, right before each Windows Security prompt.
    fn key_step(&self, step: KeyStep<'_>) {
        self.triggers.touch();
        self.ui.key_step(&KeyStepEvent::from(step));
    }

    fn key_flow(&self) -> KeyFlow<'_> {
        self.triggers.begin_flow();
        KeyFlow(self)
    }

    /// Copies `secret` in Rust. Called with the vault mutex held, so a lock can't slip
    /// in between the copy and its clipboard clear.
    fn copy(&self, vault: &Vault, secret: &SecretString) -> IpcResult<CopyResult> {
        let seconds = vault.settings()?.clipboard_clear_seconds;
        self.clipboard
            .copy_secret(secret, Duration::from_secs(seconds.into()))?;
        Ok(CopyResult {
            clears_in_seconds: seconds,
        })
    }

    /// Keeps a generated value for `copy_generated` and returns it for the edit form.
    pub(crate) fn remember_generated(&self, generated: generator::Generated) -> Generated {
        let out = Generated {
            value: WebText::new(generated.value.expose_secret()),
            entropy_bits: generated.entropy_bits,
        };
        *guard(&self.generated) = Some(generated.value);
        out
    }

    // --------------------------------------------------------------- status

    pub(crate) fn app_status(&self) -> AppStatus {
        let mut slot = guard(&self.vault);
        let builder = guard(&self.builder);
        // Look again for a vault that could not be opened (or did not exist) before,
        // unless a wizard is running.
        if builder.is_none()
            && matches!(*slot, VaultSlot::Absent | VaultSlot::Failed(_))
            && let (Ok(_), Ok(paths)) = (&self.env.authenticator, &self.env.paths)
        {
            *slot = probe(&paths.vault);
        }
        self.status_of(&slot, &builder)
    }

    // ---------------------------------------------------------------- setup

    pub(crate) fn setup_start(&self, epoch: u64) -> IpcResult<AppStatus> {
        let slot = self.vault_at(epoch)?;
        if self.phase_of(&slot) != AppPhase::Setup {
            return Err(IpcError::invalid(
                "Setup is only available before a vault exists.",
            ));
        }
        let mut builder = guard(&self.builder);
        // A fresh wizard run: any earlier, unfinished one is discarded.
        *builder = Some(VaultBuilder::new()?);
        self.triggers.set_setup_active(true);
        Ok(self.status_of(&slot, &builder))
    }

    pub(crate) fn setup_enroll_key(&self, epoch: u64, nickname: &str) -> IpcResult<KeyInfo> {
        let authn = self.authn()?;
        let _flow = self.key_flow();
        let mut builder = guard(&self.builder);
        if self.triggers.epoch() != epoch {
            return Err(IpcError::locked());
        }
        let builder = builder
            .as_mut()
            .ok_or_else(|| IpcError::invalid("Setup has not started."))?;
        let enrolled = builder.enroll_key(authn, nickname, &mut |step| self.key_step(step));
        self.triggers.touch();
        Ok(KeyInfo::from(&enrolled?))
    }

    pub(crate) fn setup_finish(&self, epoch: u64) -> IpcResult<AppStatus> {
        let paths = self.paths()?;
        let mut slot = self.vault_at(epoch)?;
        if self.phase_of(&slot) != AppPhase::Setup {
            return Err(IpcError::invalid(
                "Setup is only available before a vault exists.",
            ));
        }
        let mut builder = guard(&self.builder);
        match builder.as_ref().map(|b| b.slots().is_empty()) {
            None => return Err(IpcError::invalid("Setup has not started.")),
            Some(true) => return Err(VaultError::NoKeys.into()),
            Some(false) => {}
        }
        let Some(new_vault) = builder.take() else {
            return Err(IpcError::invalid("Setup has not started."));
        };
        self.triggers.set_setup_active(false);
        // On failure the builder (and its VMK) is gone and setup starts over; nothing
        // was written (ARCHITECTURE §6.1).
        let vault = new_vault.create(&paths.vault)?;
        let minutes = vault.settings()?.auto_lock_minutes;
        *slot = VaultSlot::Open(Box::new(vault));
        self.triggers.set_unlocked(minutes);
        Ok(self.status_of(&slot, &builder))
    }

    pub(crate) fn setup_cancel(&self, epoch: u64) -> IpcResult<AppStatus> {
        let slot = self.vault_at(epoch)?;
        if self.phase_of(&slot) != AppPhase::Setup {
            return Err(IpcError::invalid(
                "Setup is only available before a vault exists.",
            ));
        }
        let mut builder = guard(&self.builder);
        *builder = None;
        self.triggers.set_setup_active(false);
        Ok(self.status_of(&slot, &builder))
    }

    // ------------------------------------------------------------ lock state

    pub(crate) fn unlock(&self, epoch: u64) -> IpcResult<AppStatus> {
        let authn = self.authn()?;
        let mut slot = self.vault_at(epoch)?;
        {
            let VaultSlot::Open(vault) = &mut *slot else {
                return Err(IpcError::invalid("There is no vault to unlock."));
            };
            if vault.is_unlocked() {
                return Err(IpcError::invalid("The vault is already unlocked."));
            }
            self.key_step(KeyStep::UseEnrolledKey);
            let unlocked = vault.unlock(authn);
            self.triggers.touch();
            unlocked?;
            let minutes = vault.settings()?.auto_lock_minutes;
            self.triggers.set_unlocked(minutes);
        }
        let builder = guard(&self.builder);
        Ok(self.status_of(&slot, &builder))
    }

    /// The `lock` command.
    pub(crate) fn lock(&self) {
        self.lock_now(LockReason::Manual);
    }

    /// The `cancel_prompt` command: closes an open Windows Security prompt.
    pub(crate) fn cancel_prompt(&self) {
        self.cancel_pending_prompt();
    }

    // ----------------------------------------------------------------- items

    pub(crate) fn list_items(&self, epoch: u64) -> IpcResult<Vec<ItemMeta>> {
        self.with_unlocked(epoch, |vault| {
            Ok(vault.items()?.into_iter().map(ItemMeta::from).collect())
        })
    }

    pub(crate) fn get_item(&self, epoch: u64, id: &str) -> IpcResult<ItemView> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| Ok(ItemView::from(&vault.item(id)?)))
    }

    pub(crate) fn create_item(&self, epoch: u64, draft: dto::ItemDraft) -> IpcResult<ItemMeta> {
        self.with_unlocked(epoch, |vault| {
            let id = vault.create_item(draft.into())?;
            meta_of(vault, id)
        })
    }

    pub(crate) fn update_item(
        &self,
        epoch: u64,
        id: &str,
        draft: dto::ItemDraft,
    ) -> IpcResult<ItemMeta> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| {
            vault.update_item(id, draft.into())?;
            meta_of(vault, id)
        })
    }

    pub(crate) fn set_favorite(&self, epoch: u64, id: &str, favorite: bool) -> IpcResult<ItemMeta> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| {
            vault.set_favorite(id, favorite)?;
            meta_of(vault, id)
        })
    }

    pub(crate) fn trash_item(&self, epoch: u64, id: &str) -> IpcResult<ItemMeta> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| {
            vault.trash(id)?;
            meta_of(vault, id)
        })
    }

    pub(crate) fn restore_item(&self, epoch: u64, id: &str) -> IpcResult<ItemMeta> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| {
            vault.restore(id)?;
            meta_of(vault, id)
        })
    }

    pub(crate) fn delete_item(&self, epoch: u64, id: &str) -> IpcResult<()> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| Ok(vault.delete_permanently(id)?))
    }

    pub(crate) fn empty_trash(&self, epoch: u64) -> IpcResult<usize> {
        self.with_unlocked(epoch, |vault| Ok(vault.empty_trash()?))
    }

    /// The explicit reveal: the only way a secret field value reaches the webview.
    pub(crate) fn reveal_field(&self, epoch: u64, id: &str, field_id: u32) -> IpcResult<WebText> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| {
            let secret = vault.reveal_field(id, field_id)?;
            Ok(WebText::new(secret.expose_secret()))
        })
    }

    pub(crate) fn copy_field(&self, epoch: u64, id: &str, field_id: u32) -> IpcResult<CopyResult> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| {
            let secret = vault.reveal_field(id, field_id)?;
            self.copy(vault, &secret)
        })
    }

    pub(crate) fn copy_role(&self, epoch: u64, id: &str, role: FieldRole) -> IpcResult<CopyResult> {
        let id = item_id(id)?;
        self.with_unlocked(epoch, |vault| {
            let secret = vault.reveal_role(id, CoreFieldRole::from(role))?;
            self.copy(vault, &secret)
        })
    }

    // ------------------------------------------------------------- generator

    pub(crate) fn generate_password(
        &self,
        epoch: u64,
        options: dto::PasswordOptions,
    ) -> IpcResult<Generated> {
        self.with_unlocked(epoch, |_| {
            let generated = generator::password(&options.into())?;
            Ok(self.remember_generated(generated))
        })
    }

    pub(crate) fn generate_passphrase(
        &self,
        epoch: u64,
        options: dto::PassphraseOptions,
    ) -> IpcResult<Generated> {
        self.with_unlocked(epoch, |_| {
            let generated = generator::passphrase(&options.into())?;
            Ok(self.remember_generated(generated))
        })
    }

    pub(crate) fn copy_generated(&self, epoch: u64) -> IpcResult<CopyResult> {
        self.with_unlocked(epoch, |vault| {
            let generated = guard(&self.generated);
            let value = generated
                .as_ref()
                .ok_or_else(|| IpcError::not_found("Nothing has been generated yet."))?;
            self.copy(vault, value)
        })
    }

    // -------------------------------------------------------------- settings

    pub(crate) fn get_settings(&self, epoch: u64) -> IpcResult<Settings> {
        self.with_unlocked(epoch, |vault| Ok(vault.settings()?.into()))
    }

    pub(crate) fn set_settings(&self, epoch: u64, settings: Settings) -> IpcResult<Settings> {
        self.with_unlocked(epoch, |vault| {
            vault.set_settings(settings.into())?;
            let stored = vault.settings()?;
            self.triggers
                .set_auto_lock_minutes(stored.auto_lock_minutes);
            Ok(stored.into())
        })
    }

    // ------------------------------------------------------------------ keys

    pub(crate) fn list_keys(&self, epoch: u64) -> IpcResult<Vec<KeyInfo>> {
        self.with_unlocked(epoch, |vault| Ok(key_infos(&vault.slots())))
    }

    pub(crate) fn add_key(&self, epoch: u64, nickname: &str) -> IpcResult<KeyInfo> {
        let authn = self.authn()?;
        let _flow = self.key_flow();
        self.with_unlocked(epoch, |vault| {
            let added = vault.add_key(authn, nickname, &mut |step| self.key_step(step));
            self.triggers.touch();
            Ok(KeyInfo::from(&added?))
        })
    }

    pub(crate) fn rename_key(&self, epoch: u64, id: &str, nickname: &str) -> IpcResult<KeyInfo> {
        let authn = self.authn()?;
        let slot = slot_id(id)?;
        self.with_unlocked(epoch, |vault| {
            let renamed = vault.rename_key(authn, slot, nickname, &mut |step| self.key_step(step));
            self.triggers.touch();
            renamed?;
            vault
                .slots()
                .iter()
                .find(|s| s.id == slot)
                .map(KeyInfo::from)
                .ok_or_else(|| VaultError::KeyNotFound.into())
        })
    }

    pub(crate) fn remove_key(&self, epoch: u64, id: &str) -> IpcResult<Vec<KeyInfo>> {
        let authn = self.authn()?;
        let slot = slot_id(id)?;
        let _flow = self.key_flow();
        self.with_unlocked(epoch, |vault| {
            let removed = vault.remove_key(authn, slot, &mut |step| self.key_step(step));
            self.triggers.touch();
            removed?;
            Ok(key_infos(&vault.slots()))
        })
    }

    // ----------------------------------------------------------------- misc

    pub(crate) fn open_vault_folder(&self) -> IpcResult<()> {
        let paths = self.paths()?;
        // Every write already checkpoints the WAL, so `vault.efre` alone is complete.
        let exists = fs::symlink_metadata(&paths.vault).is_ok();
        let target = if exists { &paths.vault } else { &paths.dir };
        platform::show_in_explorer(target, exists)
            .map_err(|_| IpcError::internal("efre could not open the vault folder."))
    }

    pub(crate) fn security_info(&self) -> SecurityInfo {
        let slot = guard(&self.vault);
        let (key_count, settings) = match &*slot {
            VaultSlot::Open(vault) => (vault.slots().len(), vault.settings().ok()),
            _ => (0, None),
        };
        drop(slot);
        let presence = guard(&self.presence).clone();
        let system_events = guard(&self.system_events).clone();
        let browser_ui = guard(&self.browser_ui).clone();
        security::info(security::Facts {
            api_version: self.env.api_version,
            vault_path: self.vault_path_display(),
            key_count,
            settings,
            presence: &presence,
            system_events: &system_events,
            browser_ui: &browser_ui,
            hardening: &self.env.hardening,
        })
    }

    pub(crate) fn set_presence_monitor(&self, monitor: Monitor) {
        *guard(&self.presence) = monitor;
    }

    pub(crate) fn set_system_events_monitor(&self, monitor: Monitor) {
        *guard(&self.system_events) = monitor;
    }

    pub(crate) fn set_browser_ui_monitor(&self, monitor: Monitor) {
        *guard(&self.browser_ui) = monitor;
    }

    // ------------------------------------------------------------------ lock

    /// Locks (ARCHITECTURE §6.6): cancel any Windows Security prompt *first*, so it
    /// returns and lets go of the vault; wipe the keys and decrypted data (or, during
    /// setup, the wizard's builder and its VMK); clear efre's clipboard value; then
    /// tell the webview and reload it. True if anything was wiped.
    pub(crate) fn lock_now(&self, reason: LockReason) -> bool {
        let _serial = guard(&self.lock_serial);
        let cancel = || self.cancel_pending_prompt();
        cancel();
        let Some(mut slot) = acquire(&self.vault, &cancel, None) else {
            return false;
        };
        let Some(mut builder) = acquire(&self.builder, &cancel, None) else {
            return false;
        };
        let mut wiped = false;
        if let VaultSlot::Open(vault) = &mut *slot
            && vault.is_unlocked()
        {
            vault.lock();
            wiped = true;
        }
        self.triggers.set_locked();
        // Unplugging between the wizard's two keys is expected; every other trigger
        // ends the wizard.
        if reason != LockReason::Unplug && builder.take().is_some() {
            wiped = true;
        }
        if wiped {
            self.triggers.bump_epoch();
        }
        guard(&self.generated).take();
        self.clipboard.clear_if_ours();
        let notify = wiped || reason == LockReason::Manual;
        if notify {
            *guard(&self.last_lock_reason) = Some(reason);
        }
        drop(builder);
        drop(slot);
        if notify {
            self.ui.locked(reason);
        }
        wiped
    }

    /// Quitting: lock, close the vault (`close`) and clear efre's clipboard value,
    /// without touching the webview. Never waits more than about [`EXIT_WAIT`].
    pub(crate) fn shutdown(&self, close: bool) {
        let deadline = Some(Instant::now() + EXIT_WAIT);
        let cancel = || self.cancel_pending_prompt();
        cancel();
        if let Some(mut slot) = acquire(&self.vault, &cancel, deadline) {
            if let VaultSlot::Open(vault) = &mut *slot {
                vault.lock();
            }
            if close {
                // Dropping the vault closes the database cleanly.
                *slot = VaultSlot::Closed;
            }
            self.triggers.set_locked();
        }
        if let Some(mut builder) = acquire(&self.builder, &cancel, deadline) {
            builder.take();
        }
        if let Some(mut generated) = acquire(&self.generated, &|| {}, deadline) {
            generated.take();
        }
        self.clipboard.clear_if_ours();
    }

    fn request_lock(&self, reason: LockReason) {
        let _ = self.requests.send(LockRequest { reason, done: None });
    }

    /// The YubiKey presence watcher reports a change (on a Windows thread-pool thread:
    /// this only sends a message).
    #[cfg_attr(not(all(windows, not(feature = "dev-mock"))), allow(dead_code))]
    pub(crate) fn on_presence(&self, present: bool) {
        if self.triggers.set_present(present) {
            self.request_lock(LockReason::Unplug);
        }
    }

    /// Suspend, Windows lock, user switch or sign-out: lock, and wait (briefly) until
    /// it is done, so the keys are gone before the PC sleeps.
    pub(crate) fn on_system_event(&self, event: SystemEvent) {
        let (done, finished) = mpsc::sync_channel(1);
        let request = LockRequest {
            reason: lock_reason_for(event),
            done: Some(done),
        };
        if self.requests.send(request).is_ok() {
            let _ = finished.recv_timeout(SYSTEM_EVENT_WAIT);
        }
    }

    fn handle(&self, request: LockRequest) {
        self.lock_now(request.reason);
        if let Some(done) = request.done {
            let _ = done.try_send(());
        }
    }

    /// The idle trigger.
    pub(crate) fn check_idle(&self) {
        if self.triggers.idle_due() {
            self.lock_now(LockReason::Idle);
        }
    }

    /// Starts the thread that runs lock requests and checks the idle deadline. It
    /// holds only a weak reference, and stops when the state is dropped.
    pub(crate) fn spawn_lock_worker(self: &Arc<Self>) -> io::Result<()> {
        let rx = guard(&self.request_rx)
            .take()
            .ok_or_else(|| io::Error::other("the lock worker is already running"))?;
        let state = Arc::downgrade(self);
        thread::Builder::new()
            .name("efre-lock".into())
            .spawn(move || {
                loop {
                    let message = rx.recv_timeout(IDLE_CHECK_INTERVAL);
                    let Some(state) = state.upgrade() else {
                        return;
                    };
                    match message {
                        Ok(request) => state.handle(request),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                    state.check_idle();
                }
            })?;
        Ok(())
    }

    /// Tests: runs the queued lock requests on this thread.
    #[cfg(test)]
    pub(crate) fn run_lock_requests(&self) -> usize {
        let rx = guard(&self.request_rx);
        let mut handled = 0;
        if let Some(rx) = rx.as_ref() {
            while let Ok(request) = rx.try_recv() {
                self.handle(request);
                handled += 1;
            }
        }
        handled
    }
}
