# Hardware tests (phase 3): two real YubiKeys on your PC

The tool works in a throwaway vault under `%TEMP%`. It never touches `%LOCALAPPDATA%\efre`.

> ⚠️ **Never test "PIN blocked" on a key you rely on.** Unblocking a FIDO PIN
> requires a FIDO reset, which **wipes every FIDO credential on that key**, including
> all your passkeys. Use a spare key for that test, or skip it.

## 1. Prerequisites (once)
- Visual Studio 2022 Build Tools, with the "Desktop development with C++" workload.
- Rust via rustup (https://rustup.rs). The repo pins the toolchain itself.
- Node.js 22 LTS and Git.
- Both YubiKeys have a FIDO2 PIN. If one doesn't, set it under Settings → Accounts →
  Sign-in options → Security key → Manage, or in Yubico Authenticator.

## 2. Commands (PowerShell)
```powershell
git clone https://github.com/Ak1ra00/efre; cd efre      # or: git pull
git checkout phase-3-windows
npm ci; npm run build                                   # needed once before cargo test
cargo test --workspace
cargo run -p efre-core --example hardware_check         # debug build; do not add --release
```
Keep the terminal window in front. Each "Press Enter" step tells you which key to
insert.

## 3. What each step should show
| Step | You do | Expected |
|---|---|---|
| 1 | — | `Windows WebAuthn API version: N`, then PASS. N ≥ 4 is required; ≥ 6 is expected. |
| 2 | Key 1 only, then key 2 only (PIN + touch, twice per key) | PASS for both enrollments, with their AAGUIDs. Re-enrolling key 1 is refused (`AlreadyEnrolled`). |
| 3 | Key 1, then key 2 | Both unlock, and "test item decrypts intact". |
| 4 | Press Cancel; then a wrong PIN once, then the right PIN | Cancel is refused (`Cancelled`). The wrong PIN is handled inside the Windows dialog, and the right PIN unlocks. |
| 5 | Key 1 | Key 2 is renamed (1 prompt). |
| 6 | Key 1 | Key 2 is removed and the vault key rotated (1 prompt). |
| 7 | Key 2, then key 1 | Key 2 is refused (`UnknownKey`, or a NOTE with the real error). Key 1 still unlocks. |
| 8 | Unplug all keys, replug one | At least 2 events: "no YubiKey left", then "present again". |
| 9 | — | The temp folder is deleted. Summary shows 0 failed. |

A NOTE means the operation was correctly refused, but Windows reported a different
outcome than expected. That isn't a failure; write it down (section 5).

## 4. Check by eye
- [ ] The Windows Security dialog appears **over the terminal**, not behind it.
- [ ] It offers **only security keys**: no Windows Hello face/fingerprint/PIN, no
      "iPhone, iPad or Android device", no QR code.
- [ ] If your PC has an NFC reader: tapping a key on it is **not** accepted (USB only).
- [ ] A wrong PIN shows "incorrect PIN" with the retries left, inside the dialog.
- [ ] On a YubiKey Bio, the fingerprint works instead of the PIN.
- [ ] Attestation roots. On https://developers.yubico.com/PKI/ download Yubico's
      FIDO attestation root certificate(s) (PEM). For each, run
      `certutil -dump .\root.pem` and compare its `Cert Hash(sha256)` with the
      pinned SHA-256 fingerprints in `crates/efre-authn/src/attestation.rs`. They
      must match exactly.

## 5. Results to send back
Paste the tool's full output, plus:

| Item | Value |
|---|---|
| Windows edition and version (`winver`) | |
| WebAuthn API version (step 1) | |
| YubiKey models and firmware (Yubico Authenticator) | |
| Cancel → reported outcome | |
| Removed key (step 7) → reported outcome, and what the dialog said | |
| Re-enrolling key 1 → reported outcome | |
| No key plugged in during an unlock → outcome (optional) | |
| Timeout: leave the dialog open ~2 min (optional) → outcome | |
| Key with no PIN set (spare key only, optional) → what Windows offered | |
| PIN blocked (**spare key only**, optional) → outcome | |
