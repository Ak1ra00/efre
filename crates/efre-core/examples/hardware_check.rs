//! Interactive hardware check: two real YubiKeys against efre's vault, before any UI.
//!
//! Windows only. Run it from a terminal, as a debug build:
//! `cargo run -p efre-core --example hardware_check`.
//! It works in a throwaway vault under `%TEMP%` and never touches `%LOCALAPPDATA%\efre`.
//! See `docs/HARDWARE_TESTS.md` for what each step should show.

#![allow(clippy::print_stdout, clippy::print_stderr)]

/// The steps, written against the `Authenticator` trait so they compile (and are
/// linted) on every platform; only `windows_main` is Windows-specific.
#[cfg_attr(not(windows), allow(dead_code))]
mod flow {
    use std::io::{self, BufRead, Write};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use efre_authn::{Authenticator, AuthnError};
    use efre_core::{
        DraftValue, FieldDraft, FieldKind, FieldRole, ItemDraft, ItemId, ItemKind, KeyStep, Vault,
        VaultBuilder, VaultError,
    };
    use secrecy::ExposeSecret;

    #[derive(Default)]
    struct Tally {
        pass: u32,
        note: u32,
        fail: u32,
    }

    impl Tally {
        fn pass(&mut self, what: &str) {
            self.pass += 1;
            println!("PASS  {what}");
        }

        fn fail(&mut self, what: &str, why: &str) {
            self.fail += 1;
            println!("FAIL  {what}: {why}");
        }

        fn check<T>(&mut self, what: &str, result: Result<T, VaultError>) -> Option<T> {
            match result {
                Ok(value) => {
                    self.pass(what);
                    Some(value)
                }
                Err(e) => {
                    self.fail(what, &describe(&e));
                    None
                }
            }
        }

        /// The operation must be refused. The exact outcome Windows reports is printed
        /// so it can be recorded in the outcome table (ARCHITECTURE §4.7).
        fn expect_refused<T>(
            &mut self,
            what: &str,
            result: Result<T, VaultError>,
            expected: &AuthnError,
        ) {
            match result {
                Ok(_) => self.fail(what, "it SUCCEEDED but must be refused"),
                Err(VaultError::Authn(e)) if &e == expected => {
                    self.pass(&format!("{what} -> {e:?}"))
                }
                Err(e) => {
                    self.note += 1;
                    println!(
                        "NOTE  {what}: refused as required, but reported {} (expected {expected:?}); record this",
                        describe(&e)
                    );
                }
            }
        }
    }

    fn describe(e: &VaultError) -> String {
        format!("{e} [{e:?}]")
    }

    /// Prints an instruction and waits for Enter.
    pub(crate) fn pause(instruction: &str) {
        println!();
        println!(">>> {instruction}");
        print!("    Press Enter when ready... ");
        let _ = io::stdout().flush();
        let mut line = String::new();
        let _ = io::stdin().lock().read_line(&mut line);
    }

    /// Says, before each Windows Security prompt, which key it is for and why.
    fn progress_for(key: &'static str) -> impl FnMut(KeyStep<'_>) {
        move |step| match step {
            KeyStep::UseEnrolledKey => println!(
                "    -> Windows prompt: confirm with an enrolled key ({key}). PIN, then touch {key}."
            ),
            KeyStep::CreateCredential => println!(
                "    -> Windows prompt 1 of 2 for {key}: create its credential. PIN, then touch {key}."
            ),
            KeyStep::ConfirmNewKey => println!(
                "    -> Windows prompt 2 of 2 for {key}: confirm it. SAME key again: PIN, then touch {key}."
            ),
            KeyStep::UseKey { nickname } => {
                println!("    -> Windows prompt for {key} (\"{nickname}\"): PIN, then touch {key}.")
            }
        }
    }

    fn uuid(b: &[u8; 16]) -> String {
        let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
        format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        )
    }

    fn nanos() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    }

    /// A fresh folder under %TEMP% (`create_dir` fails if it already exists).
    fn temp_dir() -> io::Result<PathBuf> {
        let dir = std::env::temp_dir().join(format!(
            "efre-hwcheck-{:x}-{:x}",
            std::process::id(),
            nanos()
        ));
        std::fs::create_dir(&dir)?;
        Ok(dir)
    }

    fn test_item(secret: &str) -> ItemDraft {
        let field = |label: &str, kind, role, value: &str| FieldDraft {
            id: None,
            label: label.into(),
            kind,
            role: Some(role),
            value: DraftValue::Set(value.into()),
        };
        ItemDraft {
            kind: ItemKind::Login,
            title: "Hardware check".into(),
            favorite: false,
            tags: vec!["hwcheck".into()],
            fields: vec![
                field("Username", FieldKind::Text, FieldRole::Username, "alice"),
                field("Password", FieldKind::Hidden, FieldRole::Password, secret),
            ],
        }
    }

    fn verify_item(t: &mut Tally, vault: &Vault, item: ItemId, secret: &str) {
        match vault.reveal_role(item, FieldRole::Password) {
            Ok(value) if value.expose_secret() == secret => t.pass("test item decrypts intact"),
            Ok(_) => t.fail("test item decrypts intact", "password differs"),
            Err(e) => t.fail("test item decrypts intact", &describe(&e)),
        }
    }

    /// Runs every step; returns the process exit code (0 = no failures).
    pub(crate) fn run(
        authn: &dyn Authenticator,
        api_version: u32,
        watch_presence: &dyn Fn() -> Result<String, String>,
    ) -> i32 {
        let mut t = Tally::default();
        println!("efre hardware check: two YubiKeys (KEY 1 and KEY 2) and a throwaway vault.");
        println!();
        println!("How it works:");
        println!("  * Before every step, a '>>>' line tells you which key to plug in. Plug in");
        println!("    ONLY that key, then press Enter.");
        println!("  * Before every Windows Security prompt, a '->' line says which key it is for.");
        println!("    Each prompt: PIN (or fingerprint), then touch the key.");
        println!(
            "  * Enrolling a key takes 2 prompts in a row for the SAME key. That is expected."
        );
        println!("  * About 12 prompts in total. Credentials made here use no passkey slots.");

        println!("\n[1] Windows WebAuthn API version: {api_version}");
        if api_version >= 4 {
            t.pass("API version >= 4 (per-credential hmac-secret salts)");
        } else {
            t.fail("API version >= 4", "this Windows is too old for efre");
            return finish(&t);
        }
        if api_version >= 6 {
            println!(
                "      API >= 6: bEnablePrf is available (expected to be needed for non-discoverable hmac-secret)."
            );
        } else {
            println!(
                "      API < 6: enrollment may be refused if Windows drops hmac-secret (decision D1)."
            );
        }

        let dir = match temp_dir() {
            Ok(dir) => dir,
            Err(e) => {
                t.fail("create a temporary folder", &e.to_string());
                return finish(&t);
            }
        };
        println!("      Throwaway vault folder: {}", dir.display());
        if !steps(&mut t, authn, &dir.join("vault.efre"), watch_presence) {
            println!();
            println!("Stopped early: the remaining steps need the one that failed, so they were");
            println!("skipped. Nothing more will be asked.");
        }

        println!("\n[9] Clean up.");
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => println!("      Deleted {}", dir.display()),
            Err(e) => t.fail("delete the temporary folder", &e.to_string()),
        }
        finish(&t)
    }

    fn finish(t: &Tally) -> i32 {
        println!(
            "\nSummary: {} passed, {} notes, {} failed.",
            t.pass, t.note, t.fail
        );
        println!("Send everything above back, with the results table from docs/HARDWARE_TESTS.md.");
        i32::from(t.fail > 0)
    }

    fn steps(
        t: &mut Tally,
        authn: &dyn Authenticator,
        path: &Path,
        watch_presence: &dyn Fn() -> Result<String, String>,
    ) -> bool {
        println!("\n[2] Enroll KEY 1, then KEY 2 (2 Windows prompts per key).");
        let Some(mut builder) = t.check("start a vault", VaultBuilder::new()) else {
            return false;
        };
        pause("Plug in KEY 1 only (unplug KEY 2).");
        let Some(k1) = t.check(
            "enroll KEY 1 (attestation + hmac-secret + credProtect checks)",
            builder.enroll_key(authn, "Key 1", &mut progress_for("KEY 1")),
        ) else {
            return false;
        };
        println!("      Key 1 AAGUID {}", uuid(&k1.aaguid));
        pause(
            "Keep KEY 1 plugged in. Now efre tries to enroll KEY 1 a second time, which must be refused.",
        );
        t.expect_refused(
            "re-enrolling KEY 1",
            builder.enroll_key(authn, "Key 1 again", &mut |_| {
                println!(
                    "    -> Windows prompt for KEY 1: PIN, then touch. Windows should then say this key is already registered; close that message."
                );
            }),
            &AuthnError::AlreadyEnrolled,
        );
        pause("Unplug KEY 1. Plug in KEY 2 only.");
        let Some(k2) = t.check(
            "enroll KEY 2",
            builder.enroll_key(authn, "Key 2", &mut progress_for("KEY 2")),
        ) else {
            return false;
        };
        println!("      Key 2 AAGUID {}", uuid(&k2.aaguid));
        let Some(mut vault) = t.check("write the vault file", builder.create(path)) else {
            return false;
        };
        let secret = format!("hwcheck-{:x}", nanos());
        let Some(item) = t.check("create a test item", vault.create_item(test_item(&secret)))
        else {
            return false;
        };
        drop(vault);

        println!("\n[3] Unlock with each key (1 prompt each).");
        let Some(mut vault) = t.check("reopen the vault (locked)", Vault::open(path)) else {
            return false;
        };
        for n in [1, 2] {
            pause(&format!(
                "Plug in KEY {n} only. One Windows prompt: PIN, then touch KEY {n}."
            ));
            if t.check(&format!("unlock with KEY {n}"), vault.unlock(authn))
                .is_some()
            {
                verify_item(t, &vault, item, &secret);
                vault.lock();
            }
        }

        println!("\n[4] Outcomes the Windows dialog handles.");
        pause("Plug in KEY 1 only. When the Windows Security dialog appears, press CANCEL.");
        t.expect_refused(
            "cancelled unlock",
            vault.unlock(authn),
            &AuthnError::Cancelled,
        );
        pause(
            "Keep KEY 1 plugged in. In the next prompt, enter a WRONG PIN once (Windows shows the error), then the CORRECT PIN and touch KEY 1.",
        );
        t.check("wrong PIN, then right PIN, unlocks", vault.unlock(authn));
        if !vault.is_unlocked() {
            pause("The next steps need the vault unlocked: keep KEY 1 plugged in.");
            if t.check("unlock with KEY 1", vault.unlock(authn)).is_none() {
                return false;
            }
        }
        let Some(key2) = vault.slots().get(1).map(|s| s.id) else {
            t.fail("find key 2's slot", "missing");
            return false;
        };

        println!("\n[5] Rename KEY 2 (needs a fresh PIN + touch on an enrolled key).");
        pause("Keep KEY 1 plugged in.");
        if t.check(
            "rename key 2",
            vault.rename_key(authn, key2, "Key 2 (renamed)", &mut progress_for("KEY 1")),
        )
        .is_some()
        {
            if vault
                .slots()
                .get(1)
                .is_some_and(|s| s.nickname == "Key 2 (renamed)")
            {
                t.pass("new name stored");
            } else {
                t.fail("new name stored", "nickname unchanged");
            }
        }

        println!("\n[6] Remove KEY 2 and rotate the vault key (one prompt, for KEY 1).");
        pause("Keep KEY 1 plugged in.");
        t.check(
            "remove key 2 + rotate the vault key",
            vault.remove_key(authn, key2, &mut progress_for("KEY 1")),
        );
        vault.lock();

        println!("\n[7] The removed key must now be refused.");
        pause(
            "Unplug KEY 1. Plug in KEY 2 only. If Windows says the key isn't recognised, press Cancel.",
        );
        t.expect_refused(
            "removed key 2",
            vault.unlock(authn),
            &AuthnError::UnknownKey,
        );
        pause("Unplug KEY 2. Plug in KEY 1 only. One Windows prompt: PIN, then touch KEY 1.");
        if t.check("key 1 still unlocks after rotation", vault.unlock(authn))
            .is_some()
        {
            verify_item(t, &vault, item, &secret);
            vault.lock();
        }
        drop(vault);

        println!("\n[8] YubiKey presence watcher.");
        match watch_presence() {
            Ok(summary) => t.pass(&format!("presence watcher: {summary}")),
            Err(why) => t.fail("presence watcher", &why),
        }
        true
    }
}

#[cfg(windows)]
mod windows_main {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use efre_authn::presence_windows::{PresenceWatcher, yubikey_present};
    use efre_authn::windows::WindowsAuthenticator;
    use windows::Win32::System::Console::GetConsoleWindow;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    use crate::flow;

    /// The terminal window, so the Windows Security dialog is parented to it.
    fn parent_window() -> isize {
        // SAFETY: no preconditions; returns a null handle if there is no foreground window.
        let foreground = unsafe { GetForegroundWindow() };
        if !foreground.0.is_null() {
            return foreground.0 as isize;
        }
        // SAFETY: no preconditions; returns a null handle if there is no console.
        let console = unsafe { GetConsoleWindow() };
        console.0 as isize
    }

    fn watch_presence() -> Result<String, String> {
        let now = yubikey_present().map_err(|e| format!("{e} [{e:?}]"))?;
        println!("      YubiKey present now: {now}");
        let events = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&events);
        let watcher = PresenceWatcher::start(move |present| {
            counter.fetch_add(1, Ordering::SeqCst);
            if present {
                println!("      event: a YubiKey is present again");
            } else {
                println!("      event: no YubiKey left (efre would lock now)");
            }
        })
        .map_err(|e| format!("{e} [{e:?}]"))?;
        flow::pause(
            "Unplug ALL YubiKeys, wait two seconds, plug one back in. Events print as they happen.",
        );
        drop(watcher);
        let n = events.load(Ordering::SeqCst);
        if n >= 2 {
            Ok(format!("{n} events"))
        } else {
            Err(format!(
                "expected at least 2 events (removed, inserted), saw {n}"
            ))
        }
    }

    pub(crate) fn main() -> i32 {
        let authn = match WindowsAuthenticator::new(parent_window()) {
            Ok(authn) => authn,
            Err(e) => {
                println!("FAIL  load the Windows WebAuthn API: {e} [{e:?}]");
                return 1;
            }
        };
        let api_version = authn.api_version();
        flow::run(&authn, api_version, &watch_presence)
    }
}

fn main() {
    #[cfg(windows)]
    {
        let code = windows_main::main();
        // Keep the window open when the tool was started by double-click.
        print!("\nDone. Copy the output above if you need it, then press Enter to close... ");
        let _ = std::io::Write::flush(&mut std::io::stdout());
        let _ = std::io::stdin().read_line(&mut String::new());
        std::process::exit(code);
    }
    #[cfg(not(windows))]
    println!(
        "hardware_check is Windows-only: it drives real YubiKeys through webauthn.dll. \
         See docs/HARDWARE_TESTS.md."
    );
}
