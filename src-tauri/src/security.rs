//! The Settings "Security" page: what efre protects, and what it honestly can't
//! (ARCHITECTURE §3.3 and §8). Only protections that are active in this build and on
//! this PC are listed; a lock trigger that could not start is listed as a limit.

use efre_core::Settings;

use crate::dto::SecurityInfo;

/// Whether an OS watcher behind a lock trigger is running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Monitor {
    Active,
    Unavailable(String),
}

pub(crate) struct Facts<'a> {
    pub(crate) api_version: Option<u32>,
    pub(crate) vault_path: String,
    pub(crate) key_count: usize,
    /// The vault's settings while it is unlocked.
    pub(crate) settings: Option<Settings>,
    pub(crate) presence: &'a Monitor,
    pub(crate) system_events: &'a Monitor,
    /// The webview's own shortcuts and context menu are off.
    pub(crate) browser_ui: &'a Monitor,
}

pub(crate) fn info(facts: Facts<'_>) -> SecurityInfo {
    let settings = facts.settings.unwrap_or_default();
    let mut protections: Vec<String> = [
        "Encrypted with XChaCha20-Poly1305. The vault header and item list are \
         authenticated with HMAC-SHA256, and efre refuses to open a vault that was changed \
         outside efre",
        "Opens only with an enrolled YubiKey: its PIN or fingerprint, plus a touch. There \
         is no master password to guess",
        "Adding, renaming or removing a key needs a fresh PIN and touch on an enrolled key",
        "Removing a key replaces the vault key and re-encrypts every item",
        "Vault keys stay in efre's Rust core, in memory pages locked against paging where \
         Windows allows it, and are wiped when the vault locks",
        "Secret fields reach this window only when you reveal them, and copying happens in \
         efre's core, not in the window",
        "Screen capture and recording are blocked for efre's window",
        "Makes no network connections: no network code, a strict content security policy, \
         and navigation away from efre is blocked",
        "The vault is stored only on this PC, in %LOCALAPPDATA%\\efre, and setup never \
         overwrites an existing vault",
    ]
    .map(String::from)
    .into();
    protections.push(format!(
        "Copied values are kept out of clipboard history and the cloud clipboard, and are \
         cleared after {} seconds, on lock and on quit, if they are still on the clipboard",
        settings.clipboard_clear_seconds
    ));
    protections.push(format!(
        "Locks after {} minutes without activity",
        settings.auto_lock_minutes
    ));
    let mut limits: Vec<String> = [
        "Malware running as you while the vault is unlocked can read the screen, efre's \
         memory and the clipboard",
        "Restoring an older copy of the whole vault file can't be detected",
        "Copies of the vault made before you removed a key can still be opened with that key",
        "Items you open stay in this window's memory until the vault locks, and Windows may \
         write memory to the page file or the hibernation file. Use BitLocker",
        "Copied values are handed to Windows: efre clears its own value, but can't erase \
         copies other programs made",
        "Screen-capture blocking doesn't stop cameras, some remote-desktop or virtual-machine \
         tools, or accessibility software",
        "On SSDs, deleted data can physically remain on the drive",
        "efre trusts the Windows Security dialog, webauthn.dll, WebView2 and the YubiKey's \
         firmware",
        "Only approve Windows Security prompts you started yourself: other software could \
         ask for your key",
    ]
    .map(String::from)
    .into();
    match facts.system_events {
        Monitor::Active => protections.push(
            "Locks when the PC sleeps or hibernates, when Windows is locked, and on user \
             switch or sign-out"
                .to_owned(),
        ),
        Monitor::Unavailable(reason) => limits.push(format!(
            "Locking on sleep, Windows lock, user switch and sign-out is unavailable: {reason}"
        )),
    }
    match facts.presence {
        Monitor::Active => protections.push("Locks when no YubiKey is plugged in".to_owned()),
        Monitor::Unavailable(reason) => limits.push(format!(
            "Locking when the YubiKey is unplugged is unavailable: {reason}"
        )),
    }
    match facts.browser_ui {
        Monitor::Active => protections.push(
            "The browser's own shortcuts and context menu (print, save page, find, reload) \
             are off, so the window can't be printed or saved to a file"
                .to_owned(),
        ),
        Monitor::Unavailable(reason) => limits.push(format!(
            "Turning off the browser's print and save shortcuts is unavailable: {reason}"
        )),
    }
    SecurityInfo {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        format_version: efre_core::FORMAT_VERSION,
        webauthn_api_version: facts.api_version,
        vault_path: facts.vault_path,
        key_count: facts.key_count,
        protections,
        limits,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(presence: &'a Monitor, system_events: &'a Monitor) -> Facts<'a> {
        Facts {
            api_version: Some(9),
            vault_path: "vault.efre".into(),
            key_count: 2,
            settings: Some(Settings {
                auto_lock_minutes: 10,
                clipboard_clear_seconds: 45,
            }),
            presence,
            system_events,
            browser_ui: presence,
        }
    }

    #[test]
    fn active_triggers_are_protections() {
        let info = info(facts(&Monitor::Active, &Monitor::Active));
        assert!(info.protections.join("\n").contains("can't be printed"));
        assert_eq!(info.webauthn_api_version, Some(9));
        assert_eq!(info.key_count, 2);
        assert_eq!(info.format_version, efre_core::FORMAT_VERSION);
        let all = info.protections.join("\n");
        assert!(all.contains("after 10 minutes"), "{all}");
        assert!(all.contains("after 45 seconds"), "{all}");
        assert!(all.contains("no YubiKey is plugged in"), "{all}");
        assert!(all.contains("PC sleeps"), "{all}");
        assert!(!info.limits.join("\n").contains("unavailable"));
    }

    #[test]
    fn unavailable_triggers_are_limits_not_protections() {
        let presence = Monitor::Unavailable("no watcher".into());
        let system = Monitor::Unavailable("no events".into());
        let info = info(facts(&presence, &system));
        let protections = info.protections.join("\n");
        assert!(
            !protections.contains("no YubiKey is plugged in"),
            "{protections}"
        );
        assert!(!protections.contains("PC sleeps"), "{protections}");
        let limits = info.limits.join("\n");
        assert!(
            limits.contains("unplugged is unavailable: no watcher"),
            "{limits}"
        );
        assert!(
            limits.contains("sign-out is unavailable: no events"),
            "{limits}"
        );
        assert!(
            limits.contains("save shortcuts is unavailable: no watcher"),
            "{limits}"
        );
        assert!(!protections.contains("can't be printed"), "{protections}");
        assert!(limits.contains("whole vault file"), "{limits}");
    }

    #[test]
    fn defaults_while_locked() {
        let mut f = facts(&Monitor::Active, &Monitor::Active);
        f.settings = None;
        let info = info(f);
        let all = info.protections.join("\n");
        assert!(
            all.contains("after 5 minutes") && all.contains("after 30 seconds"),
            "{all}"
        );
    }
}
