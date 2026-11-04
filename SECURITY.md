# Security

efre is a password vault, so security comes before everything else, including
convenience and features. This page explains what efre protects you from, what it
can't protect you from, and how to report a problem.

The full technical design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
§3 there is the threat model, and §5 is the cryptographic design.

## Reporting a vulnerability

Please report security problems **privately**. Use the repository's **Security** tab
→ **Report a vulnerability** on GitHub.

Don't open a public issue for a security problem. If you need an issue for anything
else, keep secrets, vault files and PINs out of it.

A useful report includes:
- the efre version (Settings → Security);
- your Windows version;
- the steps to reproduce;
- what you expected and what happened.

Only the latest release is supported. Fixes are not backported.

## The one rule you can't undo

**There is no master password and no recovery code.** Only an enrolled YubiKey, with
its PIN or fingerprint plus a touch, can open the vault. If every enrolled key is lost,
reset or broken, **the vault is gone for good**. Nobody can open it, including the
author.

That's why setup asks you to enroll a **backup key**, and why efre keeps warning you
while only one key is enrolled.

## What protects your vault

| Layer | What it does |
|---|---|
| **Hardware key** | Opening the vault needs the YubiKey's FIDO2 `hmac-secret` output. The key gives it only after its PIN (or fingerprint) and a touch. There is no password to guess, phish or reuse. |
| **Encryption** | Every item is encrypted with XChaCha20-Poly1305 under a random 256-bit vault key. Titles, URLs, tags and dates are encrypted too. Item sizes are padded to 256-byte steps. |
| **Integrity** | The file header is authenticated with HMAC-SHA256. A second MAC covers the list of items, so editing, deleting, swapping or rolling back a single item is detected. efre refuses to open a vault that fails any check. It never tries "best effort" decryption. |
| **Per-key wrapping** | Each enrolled key wraps the same vault key under its own key-encryption key, derived with HKDF-SHA256. Keys are never stored, and neither are the YubiKey's outputs. |
| **Key management** | Adding, renaming or removing a key needs a fresh PIN + touch on an enrolled key. Removing a lost key **replaces the vault key and re-encrypts every item**. |
| **Secrets stay in the core** | Keys and decrypted secrets live only in efre's Rust core. They sit in memory that is wiped on lock, and the key pages are locked against paging. The window gets item titles and non-secret fields. A password reaches the window only when you click **Reveal**, and it hides again after 10 s. **Copy happens in the core**, so the window never sees the copied value. |
| **Clipboard** | A copied value is kept out of clipboard history (Win+V) and the cloud clipboard. It is cleared after 30 s by default, and also on lock and on quit, but only if it is still on the clipboard. Text you copied afterwards is left alone. |
| **Auto-lock** | The vault locks after 5 idle minutes by default. It also locks on sleep or hibernate, Windows lock (Win+L), user switch or sign-out, and when no YubiKey is plugged in. Locking wipes everything decrypted and reloads the window. |
| **Screen capture** | The window is excluded from screenshots and screen recording (`WDA_EXCLUDEFROMCAPTURE`). |
| **No network** | efre contains no network code and makes no connections. CI fails if an HTTP, TLS or WebSocket crate, or a network-capable Tauri plugin, ever enters the build. CI also starts the release app and fails if it, or its WebView2 processes, open any network socket, even to this PC itself. The window has a strict content security policy and can't navigate away. Its web engine has background networking turned off and can't look up any host name, so it can't connect anywhere. |
| **Window lockdown** | The webview's own print, save-page, find and reload shortcuts are off, and so is its context menu. Devtools are not compiled into release builds. Nothing is stored in browser storage. |
| **Process** | efre never asks for admin. At startup it excludes itself from Windows Error Reporting, so a crash leaves no crash report or memory dump of efre, and it turns off crash dialogs. Libraries load only from System32 or efre's own folder, never from network shares, low-integrity files, the current folder or `PATH`. `webauthn.dll` comes only from System32. WebView2 settings in `WEBVIEW2_*` environment variables, which could otherwise turn on remote debugging, are ignored. |
| **Supply chain** | Dependencies are kept to a minimum and pinned by lockfiles. CI runs `cargo-deny` (bans, licenses, sources, advisories), `cargo-audit` and `npm audit` on every push. CI also proves a release build can't contain the test-only simulated YubiKey. |

The **Settings → Security** page in the app lists the protections that are actually
active on your PC. If a protection can't start there, for example the unplug watcher,
it moves to the limits list.

## Who efre protects you from

| Someone who… | What happens |
|---|---|
| …copies your `vault.efre` (stolen laptop, a backup, a cloud copy you made) but doesn't have an enrolled YubiKey **and** its PIN | They can't decrypt anything. They learn only the plaintext header, how many items exist, and each item's size rounded up to 256 bytes. |
| …edits the vault file while efre is closed | efre detects it and refuses to open the vault, or the affected item. |
| …steals one YubiKey | They also need its PIN. The YubiKey blocks its PIN after 8 wrong tries, and after 3 in a row until it is replugged. Use **Remove lost key** with your other key: the lost key then opens nothing written afterwards. |
| …runs a phishing website | It can't ask for efre's credential. efre uses the relying-party id `efre:`, which no website can claim. The credential also stays hidden until the PIN is verified. |
| …walks up to your unlocked PC | They can see what's on screen. They can't add their own key, or rename or remove keys, without your PIN and a touch. Auto-lock limits how long the vault stays open. |
| …listens on the network | Nothing to see: efre makes no connections. |

## Honest limits

No software can promise everything. These are the limits of efre's design:

- **Malware running as you while the vault is unlocked** can read the screen, efre's
  memory and the clipboard, or inject into the process. The same goes for **any
  malware with administrator or SYSTEM rights**. efre makes this harder, but it can't
  stop it. Keep Windows updated, and don't unlock efre on a PC you don't trust.
- **Malware running while the vault is locked** can copy the file, or try to trick
  you. It could open its own Windows Security prompt for efre's key, and if you approve
  that prompt, it gets what it needs to unlock. **Only approve a Windows Security
  prompt that you started in efre.**
- **Restoring an older copy of the whole vault file can't be detected.** Single-item
  rollback is detected, but a complete older file is still a valid vault.
- **Old copies keep old keys.** A copy of `vault.efre` made *before* you removed a
  lost key can still be opened with that key and its PIN. After removing a lost key,
  replace your backup copies with a fresh one.
- **Memory:** items you open stay in the window's memory until the vault locks.
  Browser memory can't be wiped byte by byte, so the whole window is discarded
  instead. Windows may write memory to `pagefile.sys` or `hiberfil.sys`. Only the key
  pages are locked against this. **Turn on BitLocker** (or device encryption) so those
  files are encrypted too.
- **Clipboard:** once a value is on the clipboard, Windows and any program can read
  it. efre clears its own value, but it can't erase copies another program made.
  Prefer **Reveal** when you only need to read a value.
- **Screen-capture blocking** stops normal screenshots and recordings. It doesn't stop
  a camera, kernel-mode capture, some remote-desktop or virtual-machine tools, or
  accessibility software.
- **SSDs:** efre uses SQLite's `secure_delete`, but wear-levelling means old encrypted
  data can physically remain on the drive. It is still encrypted.
- **WebView2 crash dumps:** the window is drawn by WebView2, which runs in its own
  processes and handles its own crashes. Its crash dumps go to
  `%LOCALAPPDATA%\efre\webview`, and they can hold parts of what the window showed.
  Depending on your Windows diagnostic settings, Windows may send them to Microsoft.
  To limit this, open Settings → Privacy & security → Diagnostics & feedback and turn
  off **Send optional diagnostic data**.
- **Trusted parts:** efre trusts the Windows Security dialog, `webauthn.dll`, the
  WebView2 runtime and the YubiKey's firmware. A flaw in any of them is outside
  efre's control.
- **Unsigned builds:** installers are not code-signed yet, so Windows SmartScreen
  warns about them. Each release lists the installer's SHA-256 checksum. Check it
  before running the installer, or build from source if you want to verify exactly
  what runs.

## Using efre safely
1. **Enroll two YubiKeys** and keep the backup somewhere else, away from your PC
   bag.
2. **Set a good FIDO2 PIN** on each key: 6 or more characters, and not your Windows
   PIN.
3. **Turn on BitLocker** or device encryption.
4. **Back up `vault.efre` yourself.** Use Settings → Vault file → **Open vault folder**
   and copy the file. Backups are only as useful as your keys, so
   keep at least one enrolled key safe.
5. **Lost a key?** Open efre with another key, go to Settings → YubiKeys → **Remove**,
   then replace your old backup copies with a fresh one.
6. **Lock when you step away** (Ctrl+L or Win+L). Keep auto-lock short.
7. **Only approve Windows Security prompts you started in efre.**

## Optional: block efre in Windows Firewall
efre needs no network, and CI and the test checklist check that it opens none. If you
want Windows itself to enforce this, you can add an outbound block rule. Adding a
firewall rule needs admin; efre itself never asks for it.

1. In a normal PowerShell window, print efre's path:
   ```powershell
   Join-Path $env:LOCALAPPDATA 'Programs\efre\efre.exe'
   ```
2. Open PowerShell with **Run as administrator**, and create the rule with that exact
   path. Type the path itself, not `$env:LOCALAPPDATA`: an administrator window may run
   as another account.
   ```powershell
   New-NetFirewallRule -DisplayName 'efre: block outbound' -Direction Outbound `
     -Program 'C:\Users\<you>\AppData\Local\Programs\efre\efre.exe' `
     -Action Block -Profile Any
   ```
3. To check the rule, or to remove it:
   ```powershell
   Get-NetFirewallRule -DisplayName 'efre: block outbound' | Get-NetFirewallApplicationFilter
   Remove-NetFirewallRule -DisplayName 'efre: block outbound'
   ```

The rule covers `efre.exe` only. The window's web engine runs in WebView2 processes
(`msedgewebview2.exe`). Teams, Outlook and many other apps share that program, and its
path changes with every update, so efre doesn't suggest a rule for it. For WebView2,
efre relies on its content security policy, blocked navigation, its browser settings and
the zero-connection checks.
