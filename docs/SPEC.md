# Build "efre": a single-user, YubiKey-locked encrypted vault for Windows

You're working in my private repo `Ak1ra00/efre` (empty or nearly empty). Build **efre**, an offline Windows desktop app that holds my sensitive data and opens only with my YubiKey. Priorities, in order: security, reliability, UX, features. Don't add features beyond this brief.

## 0. How to work
- Start by planning. First commit: this brief verbatim as `docs/SPEC.md`, plus `docs/ARCHITECTURE.md` (design, threat model, crypto, reason for each dependency) and a short `AGENTS.md` (security invariants, commands, conventions). Then pause and show me the crypto design before implementing it.
- Work in the phases in section 9. End each phase with: tests green, clippy/lint clean, a commit, a short summary, and a manual test checklist for my PC.
- You may be in a Linux sandbox with no YubiKey. Keep Windows code behind `cfg(windows)`, verify it in GitHub Actions on `windows-latest`, and give me exact commands to build and test on my Windows machine.
- Never write your own crypto primitives. If something can't be done safely, stop and tell me rather than weakening it.

## 1. Requirements (non-negotiable)
- One user, one vault, Windows 10/11. No accounts, sign-up, email, server, cloud, telemetry, analytics, crash reporting, auto-updater, or network access of any kind.
- Unlock = YubiKey + its FIDO2 PIN (fingerprint on a YubiKey Bio) + touch. No master password and no recovery code: only enrolled YubiKeys can open the vault.
- Recovery = backup YubiKey. Setup enrolls at least 2 keys. "Add backup later" is allowed only after an explicit warning, then a persistent banner shows until a second key is enrolled.
- Storage: this computer only, in `%LOCALAPPDATA%\efre` (not Roaming, not OneDrive). Plaintext never touches disk.

## 2. Stack
- Tauri 2 (Rust stable) + React + TypeScript (strict) + Vite + Tailwind CSS + shadcn/ui (Radix) + cmdk + Motion + lucide-react. Fonts and icons bundled locally; no CDNs.
- Cargo workspace: `efre-core` (vault format + crypto, platform-independent), `efre-authn` (Authenticator trait, Windows implementation, test mock), `src-tauri` (app shell, thin IPC commands). All crypto and secret handling stays in Rust.
- Crates (verify current and maintained): `chacha20poly1305`, `hkdf`, `sha2`, `hmac`, `rand`, `zeroize`, `secrecy`, `subtle`, `rusqlite` (bundled), `windows`, `arboard`. Justify anything else in ARCHITECTURE.md.

## 3. YubiKey on Windows
- Windows 10 1903+ blocks raw FIDO HID access for non-admin apps, so use the Windows WebAuthn API (`webauthn.dll`) through the `windows` crate. Never require admin. Load webauthn.dll only from System32 (`SetDefaultDllDirectories` / `LOAD_LIBRARY_SEARCH_SYSTEM32`).
- At startup, check `WebAuthNGetApiVersionNumber()`. If hmac-secret/PRF isn't supported, show a clear "update Windows" screen.
- Enrollment (MakeCredential): cross-platform authenticator, USB, non-discoverable credential (don't use the key's passkey slots), user verification REQUIRED, credProtect = userVerificationRequired, hmac-secret/PRF enabled, direct attestation.
  - Verify the attestation chains to Yubico's published FIDO attestation root(s), and refuse non-YubiKey authenticators.
  - Store per slot: slot id, nickname, credential id, AAGUID, random 32-byte salt, enrolled date.
  - Handle keys with no FIDO2 PIN yet (guide me to set one).
- Unlock (GetAssertion):
  - Allow list = all enrolled credential IDs, cross-platform attachment, USB transport, so Windows Hello and phone passkeys aren't offered.
  - Per-credential salts via `pHmacSecretSaltValues`, UV REQUIRED, Windows Security dialog parented to efre's HWND.
  - The 32-byte PRF output is the only key material from the YubiKey.
  - Use the same UV setting at enrollment and unlock (the hmac-secret output differs with and without UV). Document exactly how Windows transforms the salts.
- Friendly UI for every outcome: no key, cancelled, timeout, unknown key, wrong PIN, PIN blocked ("use your backup key"), unsupported Windows.

## 4. Crypto design (document first, then implement exactly)
- Vault Master Key (VMK): 32 bytes from the OS CSPRNG. Subkeys via HKDF-SHA256: `data_key` ("efre/v1/data") and `header_mac_key` ("efre/v1/header").
- Key slots:
  - KEK = HKDF-SHA256(ikm = PRF output, salt = slot salt, info = "efre/v1/kek" || vault_id || slot_id).
  - Each slot stores the VMK wrapped with XChaCha20-Poly1305 under its KEK (AAD = vault_id || slot_id || format_version).
  - One slot per enrolled YubiKey, all wrapping the same VMK.
- Records: random 128-bit id + XChaCha20-Poly1305 ciphertext (random 24-byte nonce, AAD = vault_id || record_id || schema_version). Titles, URLs, tags and timestamps all live inside the ciphertext. Pad plaintext to 256-byte buckets.
- Header (format version, vault id, slots) is plaintext but authenticated with HMAC-SHA256 under `header_mac_key`. Verify it right after unwrapping the VMK, and refuse to open on a mismatch or a format-version downgrade.
- Storage: one SQLite file (WAL, `synchronous=FULL`, `secure_delete=ON`, `temp_store=MEMORY`), transactions for atomic writes, integrity check on open. Tables hold only ids, nonces and ciphertext.
- Key management:
  - Every key-management action needs a fresh YubiKey touch.
  - Adding a key = unlocked vault + the new key (PIN + touch).
  - Removing a lost key removes its slot AND rotates the VMK: re-encrypt everything, then re-wrap for each remaining key (each touched once).
  - Never store PRF outputs or KEKs.

## 5. Hardening
- Secrets live in Rust only (`secrecy`/`Zeroizing`) and are zeroized on lock and drop.
  - `VirtualLock` the key pages.
  - Exclude efre from Windows Error Reporting dumps (`WerAddExcludedApplication`).
  - No secrets in logs, errors or Debug output.
- The webview gets list metadata (title, username, type, tags) and the opened item. Secret fields arrive only when I click reveal, and auto-hide after 10 s. Copy happens in Rust, so secrets never pass through JS to be copied.
- Clipboard: set `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory = 0` and `CanUploadToCloudClipboard = 0`. Clear after 30 s (configurable), but only if it still holds our value. Clear on lock and on quit.
- Auto-lock triggers:
  - idle (default 5 min)
  - sleep/hibernate
  - Windows lock or user switch
  - YubiKey unplug: watch HID removal for Yubico VID 0x1050 and lock when no YubiKey remains
- On lock, wipe decrypted data in Rust and reset all frontend state.
- Screenshot blocking: `contentProtected` on every window, including setup and unlock. Document its limits.
- Tauri: strict CSP, least-privilege capabilities, no shell/fs/http/updater plugins, incognito webview, devtools off in release, single-instance plugin, nothing sensitive in localStorage/IndexedDB.
- Disable WebView2 features that phone home, and add a zero-outbound-connections check to my test checklist.
- CI guard (cargo-deny): fail if an HTTP client crate (reqwest, ureq, etc.) or a Tauri network plugin appears.

## 6. Features (only these)
- First-run wizard: welcome → how efre works (30-second read) → enroll primary key → enroll backup key → done.
- Unlock screen: "Insert and touch your YubiKey" with an original key illustration and pulse animation (no Yubico logos).
- Item types: Login, Secure Note (Markdown), Card, Identity, Custom. Custom fields: text, hidden, URL, email, phone, date, multiline.
- Tags, favorites, sorting, trash with restore.
- Instant fuzzy search and a Ctrl+K command palette for every action.
- Password and passphrase generator (EFF long wordlist) with a strength meter.
- Settings:
  - manage YubiKeys (nickname, enrolled date, add, rename, remove-lost-key flow)
  - auto-lock timer and clipboard timer
  - "Open vault folder", so I can copy the encrypted file myself
  - security info

## 7. UI/UX: sleek dark minimal
- Linear/Raycast-inspired look:
  - dark neutral palette with one accent color
  - Inter or Geist (bundled), 8 px grid
  - subtle 1 px borders, soft shadows
  - 150–200 ms motion that respects reduced-motion
  - optional Mica backdrop, original app icon
- Three-pane layout (sidebar → virtualized list → detail) that collapses gracefully when narrow. Dark title bar that keeps Windows 11 snap layouts.
- Keyboard-first: Ctrl+K palette, Ctrl+N new, Ctrl+F search, Ctrl+C copy password, Ctrl+B copy username, Ctrl+L lock, Esc back, `?` shortcut sheet.
- Polish: thoughtful empty states, inline validation, toasts with undo, confirmations only for destructive actions, copy feedback, friendly error copy.
- Accessibility: WCAG 2.2 AA contrast, full keyboard navigation, visible focus, screen-reader labels.

## 8. Testing
- `efre-core` tests for every crypto path:
  - round-trips and wrong key
  - every tampered field (ciphertext, nonce, AAD, header, slots) fails closed
  - downgrade rejected
  - slot add/remove and VMK rotation
  - property tests (proptest) for serialization
- `MockAuthenticator` on the same trait (deterministic HMAC; simulates cancel, timeout, wrong PIN), compiled only for tests/dev. CI proves release builds can't include it.
- Frontend: Vitest + Testing Library for the main flows.
- GitHub Actions on `windows-latest`: fmt, clippy `-D warnings`, tests, cargo-audit, cargo-deny, tsc, eslint, vitest, and an unsigned `tauri build` artifact.
- `SECURITY.md`: threat model and honest limits (e.g., malware running while the vault is open can read the screen; rolling back the whole file isn't detectable).

## 9. Phases
1. Docs, scaffold, CI. Pause for my review of the crypto design.
2. `efre-core` + MockAuthenticator + full tests (no UI).
3. Windows YubiKey integration + device watcher + hardware test checklist.
4. UI: wizard, unlock, items, search/palette, generator, settings, auto-lock, clipboard, screenshot blocking.
5. Hardening pass against SECURITY.md, zero-network verification, Windows installer (code signing later), README with setup and build steps.

Done = everything above works on my Windows PC with two real YubiKeys, CI is green, and the docs match the code.
