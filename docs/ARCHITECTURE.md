# efre — Architecture

Status: **Phases 1–5 implemented.** The app still has to be verified on the
owner's PC (`docs/APP_TESTS.md`).
- `efre-core` and the mock implement §5–§7.
- `efre-authn` has the Windows WebAuthn driver (§4), attestation verification and
  the YubiKey presence watcher. It is CI-verified on Windows, and it passed the
  hardware check on the owner's PC: WebAuthn API 9, two YubiKeys, 20 passed and 0
  failed (`docs/HARDWARE_TESTS.md` §6).
- The app (§8–§10): IPC commands, lock triggers, clipboard, window hardening, the
  React interface (`docs/FRONTEND.md`) and the phase 5 startup hardening. CI
  builds the unsigned installer and smoke-tests the release app.
- Decisions D1–D5 were accepted with their defaults (§14).

Priorities, in order: security, reliability, UX, features (see `docs/SPEC.md`).

---

## 1. What efre is

**efre** means *cave* in Tamazight. It is an offline Windows desktop vault for one person. It opens only after a
FIDO2 assertion from an enrolled YubiKey: PIN (or fingerprint on a YubiKey Bio)
plus touch. There is no master password and no recovery code. Recovery means
using a second, enrolled YubiKey.

efre never uses the network. That includes the app, the WebView, and its
dependencies (§10).

## 2. Components

```
┌──────────────────────────── efre.exe (one process, user rights) ────────────────────────────┐
│                                                                                              │
│  WebView2 (React UI)            src-tauri (app shell)            efre-core      efre-authn   │
│  ───────────────────            ─────────────────────            ─────────      ──────────   │
│  list metadata, opened item ◄── thin IPC commands ─────────────► vault format   Authenticator│
│  (no keys, no copy path)        lock triggers, clipboard,        crypto, SQLite trait        │
│                                 window hardening, WER, DLL       key slots      ├ windows.rs │
│                                 policy, device/power/session     records        │  webauthn  │
│                                 watchers                         (no OS code)   │  .dll FFI  │
│                                                                                 └ mock.rs    │
│                                                                                   (tests/dev)│
└──────────────────────────────────────────────────────────────────────────────────────────────┘
          │                                   │                                   │
          ▼                                   ▼                                   ▼
  Windows Security dialog         %LOCALAPPDATA%\efre\vault.efre        YubiKey over USB
  (PIN / fingerprint + touch,     (SQLite; header + ciphertext only)    (via webauthn.dll)
   system UI, parented to efre)
```

| Crate / package | Role | Platform code |
|---|---|---|
| `crates/efre-core` | Vault format, key hierarchy, AEAD, header MAC, SQLite storage, item model, key-slot operations. Drives an `Authenticator` but never talks to the OS. | None, apart from a small `cfg(windows)` page-locking helper (§8). |
| `crates/efre-authn` | The `Authenticator` trait and its types; the Windows implementation (webauthn.dll FFI, attestation verification); `MockAuthenticator` (feature `mock`, tests and dev only). | `cfg(windows)` |
| `src-tauri` (crate `efre`) | The app shell: Tauri setup, IPC commands, clipboard, auto-lock triggers, process hardening. It holds no crypto logic, only calls into `efre-core`. | `cfg(windows)` |
| `src/` (frontend) | React + TypeScript UI. It never sees key material and never copies secrets. | — |

Dependency direction: `efre` → `efre-core` → `efre-authn` (trait). `efre` also
depends on `efre-authn` to construct the Windows authenticator. Only
`efre-core`'s *dev*-dependencies enable `efre-authn/mock`, so normal builds never
compile the mock (§11).

## 3. Threat model

### 3.1 Assets
1. Vault contents: every item field, including titles, URLs, tags and timestamps.
2. Key material: VMK, data key, header MAC key, KEKs, and PRF outputs.
3. The integrity of the vault, meaning nobody can silently change or replace data.

### 3.2 Adversaries and what efre promises

| # | Adversary | Promise |
|---|---|---|
| A1 | Someone with a copy of `vault.efre` (stolen laptop, backup, cloud copy you made yourself) and **no enrolled YubiKey+PIN** | Learns nothing beyond the plaintext header fields (§5.6), the number of records, and each record's size rounded up to 256 bytes. Cannot decrypt anything. |
| A2 | Someone who can **modify** `vault.efre` offline | Any change to the header, a slot, a ciphertext, a nonce or a record id is detected, and efre refuses to open the vault or that record. Deleting or rolling back an individual record, or mixing records from two copies, is detected by the manifest MAC (§5.8). **Rolling back the whole file** to an older valid copy cannot be detected. |
| A3 | Someone who finds or steals **one YubiKey** | Needs the PIN too. The YubiKey locks its PIN after 8 wrong tries, or 3 in a row until it is replugged. After you run "remove lost key", that key opens nothing written afterwards (VMK rotation, §6.5). It **can still open file copies made before the removal.** |
| A4 | A website or other FIDO relying party | Cannot request efre's credential. The RP ID `efre:` is not a valid web origin (§4.3). credProtect level 3 hides the credential until UV succeeds. |
| A5 | A walk-up attacker at an **unlocked** PC with the key plugged in | Can read whatever is on screen or revealed, which no software can prevent. Cannot add their own YubiKey, rename or remove keys without a fresh PIN+touch on an enrolled key (§6.3, D2). Auto-lock limits the exposure window. |
| A6 | Other software running as you **while efre is locked** | Can copy or tamper with the file (see A1 and A2). Could trick you into approving a Windows Security prompt it opened itself, with your credential id and salt (both public), which yields the KEK. This is inherent to any FIDO-based local vault; the defence is not approving prompts you didn't start. |
| A7 | Malware running as you **while efre is unlocked**, or any malware with admin/SYSTEM | **Out of scope.** It can read efre's memory, the screen and the clipboard, and inject into the process. efre makes this harder (locked key pages, no secrets in the webview by default, clipboard exclusions, content protection) but cannot stop it. |
| A8 | Network attacker | Not applicable: efre makes no connections, and CI checks for this (§10). |
| A9 | A supply-chain attacker (a malicious crate or npm package) | Reduced by a minimal dependency set, `cargo-deny` and `cargo-audit` in CI, lockfiles, a strict CSP, no network-capable Tauri plugins, blocked navigation, and secrets kept out of JS. A malicious *Rust* dependency is game over, so every crate is justified in §12. |

### 3.3 Honest limits (summary; `SECURITY.md` is the user-facing version)
- Whole-file rollback is undetectable, as are copies made before a key was removed (A3).
- Decrypted item metadata lives in ordinary Rust memory while unlocked (zeroized on lock) and in the WebView's JS heap, which cannot be zeroized; on lock the webview document is discarded. The OS may page that memory to `pagefile.sys`. Only key pages are `VirtualLock`ed. Use BitLocker.
- Values copied to the clipboard are handed to Windows. efre clears them, but cannot erase copies held by other processes or the freed system memory.
- `contentProtected` (`WDA_EXCLUDEFROMCAPTURE`) blocks screenshots and screen recording through the normal capture APIs. It does not block cameras, kernel-mode capture, some remote-desktop or virtualisation paths, or accessibility APIs.
- SSD wear-levelling means "secure_delete" cannot guarantee that old ciphertext is physically erased.
- efre is excluded from Windows Error Reporting, but WebView2's own processes are not. They keep their own crash dumps in `%LOCALAPPDATA%\efre\webview`, which can hold fragments of what the window showed (§8.1).
- The Windows Security dialog, webauthn.dll, the WebView2 runtime and the YubiKey firmware are trusted.

## 4. YubiKey integration (Windows WebAuthn API)

### 4.1 Why webauthn.dll
Since Windows 10 1903, non-admin processes cannot open FIDO HID devices
directly. The only supported user-mode path is `webauthn.dll`, which also
provides the PIN/fingerprint UI ("Windows Security" dialog). efre never asks
for admin rights.

### 4.2 Loading
- At process start: `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)`
  (§8.1). This removes the current directory, `%windir%` and `PATH` from the DLL
  search for the whole process. It keeps efre's own folder, which holds no DLLs,
  and folders added with `AddDllDirectory`, rather than System32 alone, because
  third-party code that loads into efre (IMEs, accessibility tools) may add its
  own folder that way. WebView2 is unaffected either way: its loader uses
  absolute paths and System32 (§8.1).
- `webauthn.dll` is loaded explicitly with
  `LoadLibraryExW("webauthn.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32)`, and
  every function is resolved with `GetProcAddress`. efre never links
  `webauthn.dll` at load time; we use only the *types* from the `windows`
  crate, not its `link!` imports.
- `WebAuthNGetApiVersionNumber()` is checked once at startup.

### 4.3 Constants
| Name | Value | Why |
|---|---|---|
| RP ID | `efre:` | Not a valid web origin or registrable domain, so no website can ever request this credential. This is the same trick OpenSSH uses (`ssh:`). Verified on hardware in phase 3; the fallback is `efre.invalid`. |
| RP name | `efre` | Shown by Windows. |
| User id | the 16-byte `vault_id` | Required by the API. Not stored on the key, because the credential is non-discoverable. |
| User name / display name | `efre vault` | Shown by Windows. |
| COSE alg | ES256 (−7) | Universally supported. efre doesn't rely on assertion signatures (§4.6). |
| Timeout | 120 000 ms | Windows treats this as guidance. |

### 4.4 Required WebAuthn API version
Features per `webauthn.h` (Microsoft, `WEBAUTHN_API_VERSION_*`):

| API | What efre needs from it |
|---|---|
| 1 | MakeCredential / GetAssertion, the `hmac-secret` extension at creation, cancellation |
| 2 | `credProtect` extension |
| 4 | `GET_ASSERTION_OPTIONS` v6 → **`pHmacSecretSaltValues`** (per-credential salts) and `WEBAUTHN_ASSERTION` v3 → **`pHmacSecret`** (the output) |
| 6 | `MAKE_CREDENTIAL_OPTIONS` v6 → **`bEnablePrf`**, and `bPrfEnabled` in the attestation |

**Hard minimum: API 4.** Below that, efre shows the "update Windows" screen.

**Known platform problem.** On Windows 11 22H2 (API 4), libfido2's maintainers
observed that `webauthn.dll` **drops the `hmac-secret` extension for
non-discoverable credentials** and forwards it only when a discoverable
credential is requested. They reproduced it with Chrome too. Sources: the
libfido2 `src/winhello.c` comment and Discussion #731, 2023. Chromium now also
sets `bEnablePrf` (API 6), which is the documented way to ask for it. Nobody has
confirmed whether that fixes non-discoverable credentials. efre therefore:
1. Sends both the `hmac-secret` extension (BOOL TRUE) **and**, when API ≥ 6,
   `bEnablePrf = TRUE`.
2. **Checks the authenticator-signed authenticator data** for
   `"hmac-secret": true` and `"credProtect": 3`. If either is missing, efre
   refuses the enrollment and shows a "this Windows version can't create the
   credential efre needs" screen. It never silently falls back to a
   discoverable credential (D1).
3. Immediately runs a test GetAssertion with the new credential, which also
   produces the PRF output needed to wrap the VMK (§6.2).

Microsoft doesn't document which Windows builds report which API version. The
only data point we have is that Windows 11 22H2 reports API 4. If it turns out
that only API ≥ 6 creates the credential correctly, efre will in practice need
a current Windows 11, and Windows 10 won't work. The exact minimum gets
confirmed on your PC in phase 3, and the "update Windows" screen will name it.

**Hardware result (2026-10-31, WebAuthn API 9):** with `bEnablePrf` and the
hmac-secret extension, Windows created non-discoverable credentials. Their
signed authenticator data carries `hmac-secret: true` and `credProtect: 3`, so
D1 holds on API 9. Windows accepted the RP ID `efre:`, and both keys' packed
attestations verified against the pinned anchors. API 4–5 remain unverified.

### 4.5 MakeCredential (enrollment)
`WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS`, with `dwVersion` set to the
highest version ≤ 7 that the runtime supports:

| Field | Value |
|---|---|
| `dwAuthenticatorAttachment` | `CROSS_PLATFORM` (2) |
| `bRequireResidentKey` / `bPreferResidentKey` | `FALSE` / `FALSE`, so the credential is non-discoverable and uses no passkey slot |
| `dwUserVerificationRequirement` | `REQUIRED` (1) |
| `dwAttestationConveyancePreference` | `DIRECT` (3) |
| `Extensions` | `hmac-secret` = BOOL TRUE; `credProtect` = `{ dwCredProtect: USER_VERIFICATION_REQUIRED (3), bRequireCredProtect: TRUE }` |
| `bEnablePrf` (API ≥ 6) | TRUE |
| `pExcludeCredentialList` | Every enrolled credential id, each with `dwTransports = USB`. Re-enrolling the same key fails with `NTE_EXISTS`, and efre says "this key is already enrolled". |
| `pCancellationId` | From `WebAuthNGetCancellationId`, so a lock can cancel the dialog |
| `hWnd` | efre's main window |

Response checks. **All must pass**, or efre discards the credential and nothing is
written. Checks 1–4 run before 5–6, so a non-YubiKey is reported as rejected
attestation rather than as "update Windows".
1. `pwszFormatType == "packed"`, with an x5c chain (full basic attestation; self-attestation is refused).
2. **Attestation chain:** x5c[0..] chains, under `rustls-webpki` (§12), to
   one of these pinned trust anchors (`crates/efre-authn/src/roots/`; SHA-256
   fingerprints are asserted by a unit test and listed in `roots/README.md`):
   - *Yubico U2F Root CA Serial 457200631*, for firmware before 5.7.4;
   - *Yubico FIDO Root CA Serial 450203556* (2024);
   - the three FIDO issuing CAs under *Yubico Attestation Root 1*: *Yubico FIDO
     Attestation A 1*, *B 1* and *B2 1*. Root 1 itself is not trusted, because
     it also certifies Yubico's PIV, OpenPGP and HSM branches.

   Sources:
   - Yubico's PGP-signed CA bundle from the developers.yubico.com source
     repository. The signature was verified against a Yubico engineer's key,
     which also signs Yubico's Maven Central releases.
   - The U2F root was also cross-checked byte-for-byte against an independent
     project.

   What is checked and what is not:
   - webpki checks signatures, validity at the current time, basic constraints
     and path length, name chaining, and unknown critical extensions.
   - It does not check revocation (efre is offline by design) or certificate
     policies.
   - Any EKU, or none, is accepted.

   No network is used at runtime. If Yubico adds a new FIDO issuing CA, keys
   under it are refused until `roots/` is updated.
3. The attestation signature over `authData || SHA-256(clientDataJSON)` verifies with x5c[0]'s key, and `alg` is ES256.
4. x5c[0] **must** carry the `id-fido-gen-ce-aaguid` extension (1.3.6.1.4.1.45724.1.1.4), and it must equal the AAGUID in authData. This is required for multi-model roots (WebAuthn §8.2.1). Its subject OU must be "Authenticator Attestation".
5. authData: `rpIdHash == SHA-256("efre:")`; flags UP (0x01), UV (0x04), AT (0x40) and ED (0x80) are set, and BE/BS (0x08/0x10) are clear (not a synced passkey); the credential id equals `pbCredentialId` and is 1..=1023 bytes.
6. The authData extensions map contains `"hmac-secret": true` and `"credProtect": 3` (see §4.4).
   - If either is missing, or hmac-secret is false, the result is
     `UnsupportedPlatform` (D1).
   - A credProtect level other than 3 is `AttestationRejected`.
7. When the struct version provides it, `bResidentKey == FALSE`.
8. When the struct version provides it, `dwUsedTransport == USB`. NFC and hybrid are refused.

Keys without a FIDO2 PIN: when UV is required and no PIN is set, Windows
offers to create one in its own dialog. If the call fails with
`NTE_NOT_SUPPORTED` instead, efre shows a guide: *Settings → Accounts →
Sign-in options → Security key → Manage → Add PIN*, or Yubico Authenticator.
efre never handles the PIN itself.

### 4.6 GetAssertion (unlock and every key-management action)
`WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS`, with `dwVersion` = 6 (or the
highest version ≤ 7 the runtime supports):

| Field | Value |
|---|---|
| `pAllowCredentialList` | The relevant enrolled credentials (all of them for unlock; a single one during rotation), each `WEBAUTHN_CREDENTIAL_EX` with `dwTransports = USB`. Windows Hello and phones are therefore never offered. |
| `dwAuthenticatorAttachment` | `CROSS_PLATFORM` |
| `dwUserVerificationRequirement` | `REQUIRED`, the same as at enrollment, so the authenticator always uses `CredRandomWithUV` |
| `pHmacSecretSaltValues` | `pGlobalHmacSalt = NULL`; `pCredWithHmacSecretSaltList` = one `{credential id → {pbFirst = slot.salt (32 B), pbSecond = NULL}}` entry per allowed credential. During VMK rotation only (§6.5), `pbSecond` is the slot's new salt, so both outputs come from one touch. |
| `dwFlags` | `WEBAUTHN_AUTHENTICATOR_HMAC_SECRET_VALUES_FLAG` (0x00100000): raw salts, see below |
| `pCancellationId`, `hWnd` | As for MakeCredential |

**How Windows transforms the salts.** This is documented in `webauthn.h` and
matches what Chromium does.
- **Default (flag not set):** Windows treats each value as a WebAuthn PRF input
  and sends `SHA-256(UTF8("WebAuthn PRF") || 0x00 || value)` to the
  authenticator as the hmac-secret salt.
- **With `WEBAUTHN_AUTHENTICATOR_HMAC_SECRET_VALUES_FLAG` (efre's choice):**
  Windows passes the value through unchanged, and it MUST be exactly 32 bytes.
  The authenticator returns `HMAC-SHA-256(CredRandomWithUV, salt)`. That 32-byte
  output, `pHmacSecret->pbFirst` in `WEBAUTHN_ASSERTION` v3+, is the **only**
  key material efre takes from the YubiKey.

  Raw mode means the bytes in the vault header are exactly the bytes the
  authenticator sees, with no hidden transform. It is also the path Chromium
  and libfido2 exercise, and the output can be reproduced on any OS with
  libfido2 given the credential id, RP ID and salt.

  On the wire, Windows and the authenticator encrypt the salt and output with
  the CTAP PIN/UV protocol's shared secret; efre never sees that layer.

Response checks:
- The returned `Credential.pbId` must equal one of the allowed ids. efre looks
  up that slot.
- authData: `rpIdHash == SHA-256("efre:")`, UP and UV set.
- At assertion, the authData's `hmac-secret` extension is the **encrypted**
  output: a byte string of 32, 48, 64 or 80 bytes, not the bool it is at
  registration. efre checks only its shape and uses Windows' decrypted
  `pHmacSecret`. This was found on the first hardware run.
- `pHmacSecret` is present, and `cbFirst == 32`. Otherwise the outcome is
  "this key did not return a secret".
- efre copies `pbFirst` into a `Zeroizing<[u8; 32]>`, **overwrites Windows'
  buffer with zeros**, then calls `WebAuthNFreeAssertion`.

efre does **not** verify the assertion signature. Confidentiality rests on the
PRF output: a fake authenticator can't produce it, so a signature check would
add nothing. The credential public key is therefore not stored.

### 4.7 Outcome mapping
HRESULT → `AuthnError` → UI copy. Wrong PINs are retried *inside* the Windows
dialog, so efre only sees the final result.

Confirmed on hardware (API 9):
- `Cancelled`.
- `AlreadyEnrolled`.
- A wrong PIN is retried inside the dialog.
- An **unknown key** is handled inside Windows' own dialog ("This security key
  doesn't look familiar"). Dismissing it reports `Cancelled`, so the
  cancelled message must also cover "this key isn't enrolled".

Not yet observed: `NoDevice`, `Timeout`, `PinBlocked`, `PinNotSet`.

| HRESULT (DOM name) | efre outcome | UI |
|---|---|---|
| `NTE_USER_CANCELLED`, `HRESULT_FROM_WIN32(ERROR_CANCELLED)` (NotAllowed) | `Cancelled` (confirmed) | "Cancelled. If Windows said it didn't recognise the key, that key isn't enrolled in this vault: try your other key." |
| `HRESULT_FROM_WIN32(ERROR_TIMEOUT)` (NotAllowed) | `Timeout` | "Timed out waiting for your YubiKey." |
| `NTE_DEVICE_NOT_FOUND` (NotAllowed) | `NoDevice` | "No YubiKey found. Plug it into a USB port." |
| `NTE_NOT_FOUND` (NotAllowed) | `UnknownKey` (not seen on API 9; Windows handles it in its dialog) | "This YubiKey isn't enrolled in this vault. Try your other key." |
| `NTE_EXISTS` (InvalidState), enrollment only | `AlreadyEnrolled` (confirmed) | "This YubiKey is already enrolled. Insert a different one." |
| `NTE_NOT_SUPPORTED`, `ERROR_NOT_SUPPORTED` (Constraint) | `NotSupported` (no PIN set, or UV/credProtect unsupported) | PIN setup guide |
| PIN blocked, as observed in phase 3 | `PinBlocked` | "This key's PIN is blocked. Use your backup key, then remove this one in Settings." |
| API < 4, or authData missing hmac-secret | `UnsupportedPlatform` | "Update Windows" screen |
| Anything else | `Other(hr)` (hex code only; no secret data) | "Windows reported an error (0x…)." |

## 5. Cryptographic design (normative)

This section is the spec that phase 2 implements exactly. All integers are
**big-endian**. `||` is byte concatenation. Every field in an AAD or HKDF
`info` has a fixed length, so concatenation is unambiguous.

### 5.1 Primitives (no custom crypto)
| Use | Primitive | Crate |
|---|---|---|
| AEAD | XChaCha20-Poly1305 (24-byte nonce, 16-byte tag) | `chacha20poly1305` 0.11 |
| KDF | HKDF-SHA256 (RFC 5869) | `hkdf` 0.13 + `sha2` 0.11 |
| MAC | HMAC-SHA256, verified in constant time | `hmac` 0.13 |
| Hash | SHA-256 | `sha2` 0.11 |
| Randomness | OS CSPRNG (`ProcessPrng`/`BCryptGenRandom` on Windows, via `getrandom`) | `rand` 0.10, OS RNG only (no userspace PRNG) |
| PRF | CTAP2 hmac-secret, computed on the YubiKey | — |
| Constant-time compare | — | `subtle` 2.6 (the `hmac` crate's `verify_slice` uses it) |

Random nonces: 24-byte XChaCha nonces make random generation safe. The
collision bound is about 2⁻⁹⁶ even after 2⁴⁸ messages.

### 5.2 Constants
```
FORMAT_VERSION       = 1        (u16)   header/slot layout + key hierarchy
MIN_FORMAT_VERSION   = 1        (u16)   lowest version this build will open
SCHEMA_VERSION       = 1        (u16)   record plaintext encoding
LBL_DATA             = "efre/v1/data"       (12 bytes, ASCII)
LBL_HEADER           = "efre/v1/header"     (14 bytes)
LBL_KEK              = "efre/v1/kek"        (11 bytes)
LBL_MANIFEST         = "efre/v1/manifest"   (16 bytes)
PAD_BUCKET           = 256
```

### 5.3 Key hierarchy
```
            YubiKey i  ── hmac-secret(salt_i) ──►  PRF_i (32 B, never stored)
                                                     │
 KEK_i = HKDF-SHA256( salt = salt_i,                 ▼
                      ikm  = PRF_i,
                      info = LBL_KEK || vault_id (16) || slot_id_i (16),   L = 32 )   (never stored)
                                                     │ XChaCha20-Poly1305
                                                     ▼
 wrapped_vmk_i = Seal( key = KEK_i, nonce = wrap_nonce_i (24 B random),
                       aad = vault_id (16) || slot_id_i (16) || u16(format_version),
                       pt  = VMK )                                → 48 B (32 ct + 16 tag)

 VMK (32 B, OS CSPRNG; lives only in locked memory while unlocked)
   ├─ data_key       = HKDF-SHA256( salt = ∅, ikm = VMK, info = LBL_DATA,     L = 32 )
   ├─ header_mac_key = HKDF-SHA256( salt = ∅, ikm = VMK, info = LBL_HEADER,   L = 32 )
   └─ manifest_key   = HKDF-SHA256( salt = ∅, ikm = VMK, info = LBL_MANIFEST, L = 32 )
```
`salt = ∅` means HKDF's default, HashLen zero bytes (RFC 5869 §2.2). The VMK
is already uniform, so the salt has no security role there.

The slot salt does two jobs: it is the hmac-secret input and the HKDF salt. It
is public, random per slot, and new on every rotation.

### 5.4 Records
```
record_id   = 16 B random (reserved: 16 × 0x00 = the encrypted settings record)
nonce       = 24 B random, fresh on every write
plaintext   = u32(len(payload)) || payload || 0x00 × p,
              where total = 256 × ceil((4 + len(payload)) / 256), so the minimum size is 256
ciphertext  = Seal( key = data_key, nonce,
                    aad = vault_id (16) || record_id (16) || u16(schema_version),
                    pt  = plaintext )
```
`vault_id`, `format_version` and `schema_version` in every AAD are the values
from the vault header. When writing, they are always this build's
`FORMAT_VERSION` and `SCHEMA_VERSION`.
On decryption efre checks, in order: the AEAD tag; `4 + len ≤ total`; every
padding byte is zero; and `payload` decodes as schema v1. Any failure means the
record is refused (fail closed). The maximum payload is 1 MiB.

`payload` is a CBOR map encoded with `minicbor`. It holds the item type, title,
favourite flag, tags, created/updated/trashed timestamps and typed fields. The
details are specified in phase 2. CBOR is used because it is compact, has no
string escaping (so no stray copies of secrets in scratch buffers), and its
integer-keyed maps make it forward-compatible.

### 5.5 Header (plaintext, authenticated)
Byte layout of `header.body`, format v1:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `"EFRE"` (`45 46 52 45`) |
| 4 | 2 | `format_version` = 1 |
| 6 | 2 | `schema_version` = 1 |
| 8 | 16 | `vault_id` (random) |
| 24 | 1 | `slot_count` N (1 ..= 16) |
| 25 | … | N × slot |

Slot layout:

| Size | Field |
|---|---|
| 16 | `slot_id` (random) |
| 16 | `aaguid` |
| 32 | `salt` (random) |
| 8 | `enrolled_at` (i64, Unix seconds, UTC) |
| 2 | `cred_id_len` L (1 ..= 1023) |
| L | `cred_id` |
| 2 | `nickname_len` M (1 ..= 256 bytes) |
| M | `nickname` (UTF-8, ≤ 64 characters, no control characters) |
| 24 | `wrap_nonce` |
| 48 | `wrapped_vmk` |

```
header.mac = HMAC-SHA256( header_mac_key, header.body )      (32 B, stored next to the body)
```
The parser is strict: exact magic, known versions, lengths within bounds, no
trailing bytes, no duplicate `slot_id` or `cred_id`, and valid UTF-8 nicknames.
The MAC is computed over the exact stored bytes, so the encoding doesn't need
to be canonical.

### 5.6 What is visible without unlocking
The file shows that this is an efre vault, its format and schema versions, the
vault id, and the number of slots. For each slot it shows the nickname,
enrolled date, AAGUID (which reveals the YubiKey model), credential id and salt.
It also shows the number of records, each record's padded size, and SQLite
page-level metadata. The unlock screen displays nicknames *before* the MAC is
verified, so they are rendered as plain, length-limited text (D5).

### 5.7 Unlock (verification order)
1. Open the SQLite file and run the integrity checks in §7. Read `header.body`,
   `header.mac` and `header.manifest_mac`.
2. Parse the header strictly. Refuse if `format_version < MIN_FORMAT_VERSION`
   (downgrade) or `> FORMAT_VERSION` ("made by a newer efre").
3. GetAssertion over all slots (§4.6). The result is `(cred_id, PRF)`, and efre
   selects the slot whose `cred_id` matches.
4. Derive the KEK, then open `wrapped_vmk` with AAD `vault_id || slot_id || u16(format_version)`.
   If the tag fails: zeroize, and report "this key could not open the vault".
   Then zeroize the PRF output and the KEK.
5. Derive `header_mac_key` and **verify `header.mac` in constant time,
   immediately**. On mismatch, zeroize the VMK and refuse: "the vault file was
   modified".
6. Verify the manifest MAC over all records (§5.8), in constant time.
7. Derive `data_key`, decrypt every record, and build the in-memory metadata index (§8.2).

Why a downgrade fails closed: `format_version` is bound into every slot's AAD
(step 4) and covered by the header MAC (step 5). Editing it breaks both checks,
and a version below `MIN_FORMAT_VERSION` is refused before any key is used.
`schema_version` is likewise MACed in the header and bound into every record's
AAD.

### 5.8 Manifest MAC (D3: beyond the brief, accepted)
Without it, an attacker with write access can **delete** a record, **revert a
single record** to an older ciphertext with the same id (for example an old
password), or **mix records** from two copies of the vault. Each of those
records still decrypts. Construction:
```
manifest = LBL_MANIFEST || u16(FORMAT_VERSION) || vault_id || u32(record_count)
           || for each record, sorted by record_id:  record_id || SHA-256(nonce || ciphertext)
manifest_mac = HMAC-SHA256( manifest_key, manifest )   (stored in the header row)
```
It is recomputed inside every write transaction and verified on unlock, after
the header MAC. The cost is one pass of SHA-256 over all ciphertext per write,
about milliseconds for thousands of items. It turns "per-record
deletion/rollback is undetectable" into "only whole-file rollback is
undetectable".

### 5.9 Memory rules
- VMK, `data_key`, `header_mac_key` (and `manifest_key`) live in one
  page-aligned allocation that is `VirtualLock`ed, and are zeroized and
  unlocked on lock and on drop.
- PRF outputs and KEKs exist only on the stack or in `Zeroizing` buffers for
  the duration of one derivation. They are **never stored**.
- Secret types are `Secret*` or `Zeroizing`. Their `Debug` impls are redacted,
  they don't implement `Display` or `Serialize`, and errors never carry key or
  plaintext bytes.
- Record payloads are encoded straight into one exactly-sized buffer that is
  encrypted in place, and decrypted in place into a zeroizing buffer, so no
  reallocation leaves a plaintext copy behind. Every vault string is a `Text`
  (zeroized on drop, redacted `Debug`). Revealed values leave `efre-core` as
  `secrecy::SecretString`.

### 5.10 Record payload, schema v1
Payloads are CBOR maps with integer keys (`minicbor`). Unknown keys are ignored,
so later schemas can add fields. Trailing bytes after the map are rejected.

**Item** (every record except the settings record):

| Key | Field | Type |
|---|---|---|
| 0 | `kind` | 0 Login, 1 Secure Note, 2 Card, 3 Identity, 4 Custom |
| 1 | `title` | text, 1–256 characters, single line |
| 2 | `favorite` | bool |
| 3 | `tags` | array of text (≤ 32 tags, each 1–48 characters, unique) |
| 4 | `created_at` | int, Unix seconds |
| 5 | `updated_at` | int, ≥ `created_at` |
| 6 | `trashed_at` | int, absent unless the item is in the trash |
| 7 | `fields` | array of Field (≤ 128) |
| 8 | `next_field_id` | uint; field ids are never reused |

**Field:**

| Key | Field | Type |
|---|---|---|
| 0 | `id` | uint, 1 ≤ id < `next_field_id`, unique in the item |
| 1 | `label` | text, ≤ 64 characters |
| 2 | `kind` | 0 Text, 1 **Hidden** (secret), 2 URL, 3 Email, 4 Phone, 5 Date, 6 Multiline |
| 3 | `role` | absent, or 0 Username, 1 Password (must be Hidden), 2 URL, 3 Notes; each role at most once per item |
| 4 | `value` | text, ≤ 256 KiB |

The item types are field templates the UI fills in. For example, a Card is a
Text "Cardholder", a Hidden "Number", a Text "Expiry", and Hidden "CVV" and
"PIN" fields. The Username role is the list subtitle and Ctrl+B. The Password
role is Ctrl+C. The Notes role holds a secure note's Markdown body.

**Settings** (the record with the reserved id of 16 zero bytes):
`{0: auto_lock_minutes (1–120, default 5), 1: clipboard_clear_seconds (5–300, default 30)}`.

The limits keep every payload well under the 1 MiB record cap. Any record that
decrypts but fails decoding or validation makes the vault refuse to open.

## 6. Operations

"Prompt" means one Windows Security dialog: PIN or fingerprint, then touch.

### 6.1 Create vault (first-run wizard)
1. Generate `vault_id` (16 B) and `VMK` (32 B).
2. **Primary key:** MakeCredential (prompt 1) and every check in §4.5. Then a
   fresh slot `salt`, and GetAssertion on the new credential only (prompt 2),
   which gives the PRF. Derive the KEK and wrap the VMK.
3. **Backup key:** the same steps, with the primary's credential in the exclude
   list (prompts 3 and 4).
   - "Add backup later" is allowed only after an explicit warning dialog. The
     vault then has one slot, and a persistent banner stays until a second
     slot exists.
4. Write the file atomically.
   - Build `vault.efre.tmp` with the header, MAC, settings record and manifest
     in one transaction, then close it and flush it to disk.
   - **Hard-link** it to `vault.efre`, which fails if that name already exists,
     so efre can never overwrite a vault. Then remove the temporary name.
     NTFS, the system drive's file system, supports hard links.
   - Nothing reaches disk before this step. Non-discoverable credentials keep
     no state on the YubiKey, so an aborted wizard leaves nothing behind.

### 6.2 Unlock
See §5.7. One prompt.

### 6.3 Add a key (vault unlocked)
1. **Fresh proof from an enrolled key** (prompt 1): GetAssertion over the
   enrolled slots, re-derive the VMK, and check that it equals the in-memory
   VMK in constant time. This goes beyond the brief, which only requires the
   new key's PIN+touch (D2). It stops someone at your unlocked PC from enrolling
   their own key.
2. New key: MakeCredential (prompt 2), then GetAssertion (prompt 3). Wrap the
   VMK for a new slot.
3. In one transaction: write the new header and its MAC. Records and the
   manifest are unchanged.

The UI is told what to say before each prompt (`KeyStep`): "use an enrolled
key", "insert the new key", "touch the new key again".

### 6.4 Rename a key
A fresh assertion from any enrolled key (1 prompt), then update the header and MAC in one transaction.

### 6.5 Remove a (lost) key and rotate the VMK
Requires at least 2 slots. efre shows a confirmation that says plainly: "Copies
of `vault.efre` made before now can still be opened with the removed key.
Delete them and make a fresh copy afterwards."
1. Generate `VMK′`, and for each remaining slot j a new `salt′_j` and `wrap_nonce′_j`.
2. For each remaining slot, one at a time, run one GetAssertion (one prompt per
   remaining key). It uses `allow = [cred_j]`, with the current `salt_j` as the
   first salt and `salt′_j` as the second, both evaluated in the same touch.
   - The first output must unwrap slot j to the open VMK (constant-time
     compare). This proves that key still opens this vault. Otherwise abort.
   - The second output gives `KEK′_j` and `wrapped_vmk′_j`.
   - If you cancel at any point, nothing is written.
3. One transaction:
   - decrypt every record with the old `data_key`, and re-encrypt it with
     `data_key′` under a fresh nonce and the same `record_id`;
   - write the new header (without the removed slot), its MAC under
     `header_mac_key′`, and the manifest.
4. After the commit, the in-memory keys are swapped and the old ones zeroized.
   The commit already truncated the WAL, and `secure_delete` already zeroed the
   freed pages. `VACUUM` then rewrites the file as defence in depth; if it
   fails, the committed rotation stands.
5. If only one slot remains, the "add a backup key" banner returns.

The remaining slots' salts are rotated as well, which costs nothing because
each key is touched anyway. As a result *every* KEK changes, not just the
VMK.

### 6.6 Lock
Cancel any pending WebAuthn operation. Zeroize the keys and the decrypted
index. Clear the clipboard if it still holds efre's value. Then navigate the
webview to a fresh document, which discards all JS state, and show the unlock
screen.

### 6.7 Unplug-lock during key management
Swapping keys on a single USB port would otherwise lock the vault halfway
through a flow. While an add, remove or rotate flow is active (bounded by its
timeouts), the "no YubiKey present" trigger is suspended. Idle, sleep and
session-lock triggers stay active and cancel the flow. When the flow ends,
efre locks immediately if no YubiKey is present.

## 7. Storage

- Path: `%LOCALAPPDATA%\efre\vault.efre`, resolved with
  `SHGetKnownFolderPath(FOLDERID_LocalAppData)`. It is never in Roaming, and
  OneDrive Known Folder Move doesn't cover LocalAppData. efre refuses to run if
  `%LOCALAPPDATA%\efre` is a reparse point (junction or symlink).
- The WebView2 user-data folder is `%LOCALAPPDATA%\efre\webview` (incognito; it
  holds no vault data).
- SQLite comes from `rusqlite` with the `bundled` feature, so the SQLite
  version is pinned rather than whatever the system ships.
- Connection hardening, applied before anything reads the file:
  - the vault file must not be a symbolic link. `efre-core` checks this on
    every platform; `SQLITE_OPEN_NOFOLLOW` repeats the check on Unix only,
    because SQLite's Windows VFS ignores it;
  - `SQLITE_DBCONFIG_DEFENSIVE` on;
  - triggers, views, trusted schema and `ATTACH`-create off;
  - no extension loading.
- Pragmas on every open:
  - `journal_mode=WAL`
  - `synchronous=FULL`
  - `secure_delete=ON`
  - `temp_store=MEMORY`
  - `locking_mode=EXCLUSIVE` (no `-shm` file, and no other process can open the db while efre has it)
  - `trusted_schema=OFF`
  - `cell_size_check=ON`
  - `foreign_keys=ON`
  - `application_id=0x65667265` (`'efre'`)
  - `user_version=1`
- Schema (exactly this; anything else in `sqlite_schema` means refuse to open):
  ```sql
  CREATE TABLE header  (id INTEGER PRIMARY KEY CHECK (id = 1),
                        body BLOB NOT NULL, mac BLOB NOT NULL CHECK (length(mac) = 32),
                        manifest_mac BLOB NOT NULL CHECK (length(manifest_mac) = 32));
  CREATE TABLE records (id BLOB PRIMARY KEY CHECK (length(id) = 16),
                        nonce BLOB NOT NULL CHECK (length(nonce) = 24),
                        ciphertext BLOB NOT NULL CHECK (length(ciphertext) >= 272)) WITHOUT ROWID;
  ```
  The minimum ciphertext length, 272, is a 256-byte padded plaintext plus the
  16-byte tag.
- On open: `PRAGMA integrity_check` must return `ok`; `application_id`,
  `user_version` and the schema SQL must match exactly; there must be exactly
  one header row. Records shorter than 272 bytes are refused even if a `CHECK`
  constraint was bypassed.
- Writes: every change is one `BEGIN IMMEDIATE … COMMIT`, followed by
  `wal_checkpoint(TRUNCATE)`, so `vault.efre` alone is a complete, consistent
  copy whenever the app is idle. "Open vault folder" and quit also checkpoint.
- Settings (auto-lock and clipboard timers) are stored *inside* the vault, as
  the encrypted record with the reserved all-zero id. The only plaintext efre
  keeps on disk is the header.

## 8. Process and memory hardening (src-tauri)

### 8.1 At startup, before any window exists
`src-tauri/src/hardening.rs` runs first in `main()`. At that point efre is still
single-threaded, and Tauri has not yet created a window or loaded WebView2.

Every step is best effort. A step that Windows refuses never stops efre. Settings ›
Security then lists that step as a limit, with Windows' reason, instead of as a
protection. This is the same rule as for the lock triggers (§8.5).

| Step | Call | Notes |
|---|---|---|
| Crash dialogs | `SetErrorMode(GetErrorMode() \| SEM_FAILCRITICALERRORS \| SEM_NOGPFAULTERRORBOX)` | Turns off the crash dialog, which would keep a crashed efre, and its memory, alive until dismissed. Also turns off the "insert a disk" dialog. Verified with `GetErrorMode`. Child processes inherit the mode. WebView2's processes keep it; Explorer, started by "Open vault folder", gets `CREATE_DEFAULT_ERROR_MODE`. |
| DLL search | `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)` | See §4.2 and below. |
| Image loads | `SetProcessMitigationPolicy(ProcessImageLoadPolicy)` with `NoRemoteImages`, `NoLowMandatoryLabelImages` and `PreferSystem32Images` | If Windows rejects the set, efre retries without `PreferSystem32Images`. The reported outcome is what `GetProcessMitigationPolicy` says is enforced, so a policy an administrator already applies through Exploit Protection also counts. |
| Crash reports | `WerAddExcludedApplication(<exe file name>, FALSE)` | Per user, so no admin is needed. It writes `HKCU\Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications\efre.exe` on every start. The uninstaller removes it (§9). |
| WebView2 overrides | Delete every `WEBVIEW2_*` environment variable | See §10. |

The release profile uses `panic = "abort"`. A Rust abort is a fail-fast exception,
which goes straight to Windows Error Reporting, hence the exclusion. A panic never
prints secret data, because secret types have no `Display`.

`tauri-plugin-single-instance` means a second launch focuses the existing window.

**WebView2 still works under these policies; this was checked, not assumed.**
- efre links the WebView2 loader statically, as `WebView2LoaderStatic.lib` from
  `webview2-com-sys` 0.39.1. The disassembled loader shows two kinds of load:
  - It loads its helpers with `LoadLibraryExW(…, LOAD_LIBRARY_SEARCH_SYSTEM32)`.
    The helpers are `advapi32.dll`, `version.dll` or
    `api-ms-win-core-version-l1-1-0.dll`, and `shell32.dll`.
  - It loads the runtime's `EBWebView\x64\EmbeddedBrowserWebView.dll` with
    `LoadLibraryW(<absolute path>)`.
- Neither load depends on the current folder or `PATH`, and an absolute path is not
  searched at all. So neither `SetDefaultDllDirectories` nor `PreferSystem32Images`
  changes what WebView2 loads.
- WebView2's browser, renderer and GPU processes are separate `msedgewebview2.exe`
  processes. They don't inherit DLL directories or mitigation policies that efre
  sets at runtime.
- The CI smoke test (§11) checks that WebView2 starts under these policies.

**Other code in efre's process.**
- `SetDefaultDllDirectories` removes the current folder, `%windir%` and `PATH` from
  DLL searches. Two kinds of code would break:
  - code that found its DLLs in those folders;
  - code that calls `LoadLibraryEx` with `LOAD_WITH_ALTERED_SEARCH_PATH` and a
    *relative* name. Microsoft documents this as undefined, and it fails once
    default directories are set.

  The only candidates in efre's process are third-party IMEs and text services, and
  accessibility or security tools that inject DLLs. Those load by absolute path,
  and System32 is still searched. Tauri, tao, wry and muda load only System32 DLLs
  by name.
- `PreferSystem32Images` only reorders a search: a DLL found in System32 wins over a
  copy with the same name elsewhere. efre ships no DLLs. Firefox enables this
  policy in its browser process, and Chromium's sandbox applies the same image-load
  policy at runtime.
- "Open vault folder" starts `%SystemRoot%\explorer.exe` as a separate process,
  without `ShellExecute`, so no shell extension loads into efre.
- DLLs that `efre.exe` imports statically are resolved before `main()`, with the
  application folder searched first. Examples are `wer.dll`, `wtsapi32.dll`,
  `cfgmgr32.dll` and `powrprof.dll`. The application folder is the user's own (§9),
  and anything that can write there can replace `efre.exe` itself (A7). Firefox
  documents the same position.

**Not enabled, and why.**
- **Strict handle checks** (`ProcessStrictHandleCheckPolicy`). This turns any use of
  an invalid handle, by any code in the process, into a crash, and it can't be
  turned off again.
  - Third-party code that loads into efre would then crash the vault on a harmless
    stale-handle bug. That code includes WebView2's client DLL, IMEs and text
    services, and accessibility and security tools.
  - The policy defends against handle-confusion exploits driven by hostile input,
    and efre's process handles almost none. The vault is authenticated before use,
    and web content runs in WebView2's own processes.

  Reliability wins here.
- **Extension-point disable** blocks legacy IMEs, AppInit DLLs and the global hooks
  that accessibility tools use.
- **Dynamic code (ACG)** and **Microsoft-signed images only** break IMEs, and
  accessibility or security tools, that load into the process or generate code.
- **Child-process policy** is impossible: WebView2 and Explorer are child processes.
- **Win32k system-call disable** is impossible for a GUI process.
- DEP, ASLR (high-entropy, bottom-up) and heap termination on corruption are already
  on for 64-bit Rust executables. There is nothing to set.

**What the WER exclusion doesn't cover.**
- **WebView2's processes.** `msedgewebview2.exe` is a shared system binary, and WER
  excludes by file name, so excluding it would affect every app's WebView2.
  - WebView2 writes minidumps of its own crashed processes into its failure-report
    folder, inside its user-data folder (`%LOCALAPPDATA%\efre\webview`).
  - Those dumps can hold fragments of what the window showed, such as item metadata
    or a revealed field.

  Settings › Security lists this as a limit.
- **Crash-dump collection an administrator sets up**, such as WER `LocalDumps` or a
  postmortem debugger. This is out of scope (A7).

### 8.2 Decrypted data in memory
- On unlock efre decrypts every record once and keeps only a **metadata index**
  (id, type, title, username, tags, favourite, timestamps, trashed flag) in
  `Zeroizing` strings. It drops the rest of each plaintext immediately.
- Opening an item decrypts that record again. Secret fields are decrypted on
  demand for *reveal* or *copy*, then zeroized.
- Key pages are `VirtualLock`ed (§5.9). The metadata index is not locked (see §3.3).

### 8.3 Webview boundary (IPC)
- JS receives list metadata and the non-secret fields of the opened item.
  Secret fields are passwords, card number, CVV and PIN, and hidden custom
  fields.
  - JS receives a secret field only through `reveal_field(item, field)`. The
    UI re-hides it after 10 s.
  - `copy_field(item, field)` copies **in Rust**: the value never enters JS.
- When you type or edit a secret, it necessarily exists in the webview's input
  until you save. That is the only other path. Generated passwords are created
  in Rust and inserted into the edit form.
- Editing never sends existing secrets to the webview: a field you didn't
  change is saved as `DraftValue::Keep`, and Rust keeps the stored value.
- IPC payloads are small typed structs. Rust validates every id and length.
  Commands that need an unlocked vault fail with `Locked` otherwise.
- Nothing is stored in `localStorage`, `sessionStorage`, IndexedDB or cookies.
  The webview is incognito, and the UI state store lives only in memory.

### 8.4 Clipboard (arboard + Win32)
- `arboard::SetExtWindows`: `exclude_from_monitoring()`, `exclude_from_history()`
  and `exclude_from_cloud()`. These set `ExcludeClipboardContentFromMonitorProcessing`,
  `CanIncludeInClipboardHistory = 0` and `CanUploadToCloudClipboard = 0`.
- After setting the clipboard, efre records `GetClipboardSequenceNumber()`. The
  timer clears the clipboard (default 30 s, configurable) **only if the
  sequence number is unchanged**, meaning nobody has copied anything since. The
  same check runs on lock and on quit. efre never reads the clipboard back.

### 8.5 Auto-lock triggers
| Trigger | Mechanism |
|---|---|
| Idle (default 5 min) | Rust-side deadline, reset by user input inside efre (throttled pings from the UI) and by IPC activity |
| Sleep / hibernate | `PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK)`, `PBT_APMSUSPEND`. The lock happens before RAM goes to `hiberfil.sys`. |
| Windows lock / user switch | `WTSRegisterSessionNotification` on a hidden window: `WTS_SESSION_LOCK`, `WTS_CONSOLE_DISCONNECT`, `WTS_REMOTE_DISCONNECT`, `WTS_SESSION_LOGOFF` |
| YubiKey unplugged | `CM_Register_Notification` on `GUID_DEVINTERFACE_HID` (`efre_authn::presence_windows::PresenceWatcher`). Each arrival or removal re-enumerates present HID interfaces (`CM_Get_Device_Interface_List`) and looks for `VID_1050` as a whole token of the hardware id. efre locks when none remain (see §6.7). Only changes are reported, and a failed enumeration counts as "no YubiKey". No device is opened, so no admin is needed. |
| Ctrl+L / quit | Direct |

If the unplug watcher or the sleep/session watcher can't start on a given PC, efre
keeps running. Settings › Security lists that trigger as unavailable, with Windows'
reason.

**Decision (phase 5): keep running.**
- These triggers protect an unlocked session. The vault at rest depends only on the
  cryptography (§5), and a missing watcher doesn't weaken it.
- Refusing to start would turn a Windows hiccup into a lockout from your own data,
  with no way around it. One example is Remote Desktop Services not yet running at
  sign-in, which the session watcher already retries.
- The vault can always be locked: the idle timer runs inside efre, and Ctrl+L always
  works. You can also see exactly which trigger is missing.

The startup hardening steps follow the same rule (§8.1).

### 8.6 Screenshot blocking
Every window is `contentProtected: true`, which maps to
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`. This includes the wizard and
unlock screen, because efre has a single window and all dialogs are in-app.
See §3.3 for what it doesn't block.

## 9. Tauri configuration
- **CSP:**
  ```
  default-src 'none'
  script-src 'self'
  style-src 'self'
  img-src 'self' data:
  font-src 'self'
  connect-src ipc: http://ipc.localhost
  base-uri 'none'
  form-action 'none'
  frame-ancestors 'none'
  object-src 'none'
  ```
  Tauri adds hashes for its own scripts. There are no remote origins, so
  Markdown images pointing to `https://…` are blocked as well.
- `withGlobalTauri: false` and `freezePrototype: true`.
- **Capabilities:** one capability for the main window only, granting efre's
  own commands plus the minimal `core:` permissions the UI needs. The
  shell/fs/http/updater/opener plugins are **not** installed, and CI bans them
  (§10).
- **Navigation:** `on_navigation` allows only the app origin; new windows are
  denied. A compromised script can't leave the app or carry data out in a URL.
- **Devtools:** the `devtools` Cargo feature is not enabled, so release builds
  have none.
- **Window:**
  - native decorations with `theme: "Dark"` (a DWM dark title bar), which keeps
    snap layouts;
  - `contentProtected: true`;
  - `incognito: true`;
  - a dark window and webview background (#0e0f11), so there is no white flash;
  - WebView2's browser accelerator keys (Print, Save as, Find, reload) and its
    default context menu are switched off through the WebView2 settings object.
    Print or Save as would otherwise write plaintext to disk. Copy and paste
    still work in text fields.
  - **No Mica backdrop (decided in phase 5).** The brief lists Mica as optional,
    and it adds DWM and transparency code for no security value:
    - Mica needs a transparent window and webview instead of the opaque #0e0f11
      background that prevents a white flash.
    - It exists only on Windows 11 22H2 and later (`DWMWA_SYSTEMBACKDROP_TYPE`),
      and needs a different fallback elsewhere.
    - Its interaction with `WDA_EXCLUDEFROMCAPTURE` and the dark title bar would
      need testing on every target.
- **Installer:** NSIS with `installMode: currentUser`, so no admin. The installer
  is unsigned for now.
  - **Releases** (`.github/workflows/release.yml`) run when a `v*` tag is pushed, or
    by hand from the Actions tab (which then creates the `v<version>` tag). They merge
    `src-tauri/tauri.release.conf.json`, which sets `webviewInstallMode` to
    `offlineInstaller`. The installer then carries Microsoft's offline WebView2
    Runtime installer, about 180 MB.
    - The tauri-bundler template runs it only when WebView2 isn't registered in
      HKLM or HKCU.
    - It runs with the installer's own rights, so WebView2 is installed per user,
      with no admin and no download at install time.
    - The workflow checks that the embedded installer is validly signed by
      Microsoft and that the setup file contains it. It runs the smoke and
      installer tests (`scripts/ci/`) on the exact file it publishes, then
      attaches it and `SHA256SUMS.txt` to the GitHub release.
  - **CI builds** keep `webviewInstallMode: skip`. They stay small, and Windows 11
    already ships WebView2. The bootstrapper modes are never used, because they
    download at install time.
  - The installer puts efre in `%LOCALAPPDATA%\Programs\efre`, Windows' folder for
    per-user programs. The template's default, `%LOCALAPPDATA%\<productName>`, is
    the vault folder, so the binaries and the vault would otherwise share a folder.
  - `src-tauri/windows/installer-hooks.nsh` does this without a custom template
    (`bundle.windows.nsis.installerHooks`). It was checked against the
    tauri-bundler 2.10.4 template inside `@tauri-apps/cli` 2.12.4, and it compiles
    with `makensis -WX`:
    - The template's `.onInit` sets `$INSTDIR` to `$LOCALAPPDATA\efre` unless `/D=`
      was given. `RestorePreviousInstallLocation` then replaces it with the
      previous install location from `HKCU\Software\<publisher>\efre`.
    - Modern UI's `.onGUIInit` (`MUI_CUSTOMFUNCTION_GUIINIT`) replaces
      `$LOCALAPPDATA\efre` with `$LOCALAPPDATA\Programs\efre`, before the
      directory page shows it.
    - `NSIS_HOOK_PREINSTALL` does the same, before any file is copied. This covers
      silent installs, which skip `.onGUIInit`, and the vault folder typed into the
      directory page.
    - `NSIS_HOOK_POSTINSTALL` handles an install over an earlier build that lived in
      the vault folder. It deletes exactly that build's `efre.exe` and
      `uninstall.exe` there and retargets its desktop shortcut. The template
      already recreates the Start menu shortcut.
  - The vault is never at risk from the uninstaller:
    - It deletes only its own files in the install folder, and removes that folder
      only if it is empty (`RMDir` without `/r`).
    - Its "delete app data" option removes `%LOCALAPPDATA%\<bundle id>` and
      `%APPDATA%\<bundle id>`, not `%LOCALAPPDATA%\efre`.
    - `NSIS_HOOK_POSTUNINSTALL` removes efre's per-user WER exclusion value (§8.1),
      except during an update.
  - The `webview` folder in `%LOCALAPPDATA%\efre` holds WebView2's cache and no
    vault data. The uninstaller leaves it; delete it by hand if you like.
  - CI installs silently, checks the location, uninstalls, and checks that a
    stand-in `vault.efre` is unchanged (§11).

## 10. Network isolation
- **Rust:** no HTTP/TLS/WebSocket client crates. `deny.toml` bans
  - reqwest, ureq, hyper, h2, isahc, curl, attohttpc, surf, minreq, rustls,
    native-tls, openssl, tungstenite, quinn, …;
  - every network-capable Tauri plugin.

  CI fails if any of them appears in the graph.
  - One known caveat: tokio's `net` feature is compiled in, because
    `tauri-plugin-single-instance` enables it for its macOS Unix-socket path.
    On Windows that plugin uses only a named mutex and `WM_COPYDATA`. No
    efre or Tauri code path opens a socket, and the runtime
    zero-connection check verifies this.
- **WebView2:**
  - The CSP allows no remote origins, navigation is blocked, and the webview is
    incognito.
  - `additionalBrowserArgs` keeps Tauri's defaults
    (`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`) and adds
    `--disable-background-networking`, `--disable-component-update`,
    `--disable-domain-reliability`, `--disable-sync`, `--no-pings`,
    `--disable-client-side-phishing-detection` and `--no-first-run`.
  - It also adds `--host-resolver-rules="MAP * ~NOTFOUND"`, so every host name
    lookup in WebView2's network service fails.
    - efre's page and IPC (`http://tauri.localhost`, `http://ipc.localhost`) are
      answered inside WebView2 before any lookup, so the app is unaffected.
    - Without it, Chromium opened a speculative connection from a WebView2
      process to the app origin on `[::1]:80`. The CI smoke test caught this
      (2026-11-04): no request was sent, but a local program listening on port 80
      would have been contacted.
    - With it, nothing in WebView2 can reach a socket by name, loopback included.
  - SmartScreen and reputation checks are off, as are autofill and password
    autosave.
  - The WebView2 loader and runtime read `WEBVIEW2_*` environment variables,
    which override or extend an app's own settings. For example:
    - `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, which
      developers set for debugging, would open a debugging socket into efre's
      window;
    - `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` swaps in another runtime.

    efre deletes every `WEBVIEW2_*` variable from its own environment at startup
    (§8.1), so neither its loader nor its WebView2 processes see them. The
    equivalent policy values under `Software\Policies\Microsoft\Edge\WebView2` need
    admin to write (A7).
  - These are best effort. WebView2 runtime updates are done by Edge Update,
    outside efre's process.
- **Verification:**
  - CI starts the release `efre.exe` and fails if it, or a WebView2 process in its
    data folder, opens any TCP or UDP socket (§11).
  - The checklists include a zero-outbound-connections check on your PC. Run
    Resource Monitor's Network tab, or `Get-NetTCPConnection` and
    `Get-NetUDPEndpoint`, for `efre.exe` and its `msedgewebview2.exe` children
    during unlock, browse, copy and lock.

### 10.1 Optional: a Windows Firewall rule (your choice; needs admin)
efre never needs admin rights, and it doesn't need this rule. If you also want
Windows to enforce "no network" for `efre.exe`, add an outbound block rule. Adding a
firewall rule needs an administrator PowerShell.

1. In a normal PowerShell window, signed in as yourself, print efre's path:
   ```powershell
   Join-Path $env:LOCALAPPDATA 'Programs\efre\efre.exe'
   ```
2. Open PowerShell with **Run as administrator** and create the rule with that
   exact path:
   ```powershell
   New-NetFirewallRule -DisplayName 'efre: block outbound' -Direction Outbound `
     -Program 'C:\Users\<you>\AppData\Local\Programs\efre\efre.exe' `
     -Action Block -Profile Any
   ```
   Type the literal path rather than `$env:LOCALAPPDATA`. An administrator window
   may run as another account, and the firewall service would expand
   `%LOCALAPPDATA%` for itself, not for you.
3. To check the rule, or to remove it again:
   ```powershell
   Get-NetFirewallRule -DisplayName 'efre: block outbound' | Get-NetFirewallApplicationFilter
   Remove-NetFirewallRule -DisplayName 'efre: block outbound'
   ```

Things to know:
- The rule covers `efre.exe` only. efre's window is drawn by WebView2's
  `msedgewebview2.exe` processes, so the rule doesn't cover them.
  - `msedgewebview2.exe` is a shared system binary in
    `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\<version>\`.
  - Teams, Outlook, Widgets and many other apps use it, so a rule for it would
    block all of them.
  - Its path changes with every runtime update, so such a rule would stop matching.

  efre therefore doesn't suggest a rule for WebView2. For WebView2, efre relies on
  the CSP, blocked navigation, its browser arguments and the zero-socket checks.
- A block rule wins over allow rules. It applies only while Microsoft Defender
  Firewall is on; a third-party firewall has its own rules.
- If you install efre somewhere else, point the rule at that `efre.exe`.

## 11. Build, test, CI
- **Mock gating:**
  - `MockAuthenticator` lives behind the `efre-authn/mock` feature, which only
    `efre-core`'s dev-dependencies and the app's `dev-mock` feature enable.
  - `#[cfg(all(feature = "mock", not(debug_assertions)))] compile_error!(…)`
    makes a release build with the mock fail to compile.
  - CI also builds the release binary and fails if `cargo tree -e features`
    shows `mock`, or if the binary contains the mock's unique marker string.
- **CI** (GitHub Actions, `windows-latest`, actions pinned by commit SHA):
  - `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
  - `cargo audit --deny warnings` and `cargo deny check`. A few advisories
    for crates that exist only in Tauri's Linux backend (GTK, D-Bus) are
    ignored in `.cargo/audit.toml`. A CI step fails if any of those crates
    ever appears in the Windows dependency graph.
  - `tsc --noEmit`, `eslint`, `vitest run`
  - the mock-exclusion check
  - an unsigned `tauri build` (NSIS) uploaded as an artifact
  - a smoke test of that build (phase 5). The release `efre.exe` runs for 25 s, and
    the step fails if:
    - efre exits;
    - no `msedgewebview2.exe` with `\efre\webview` in its command line appears, which
      means WebView2 didn't start under the §8.1 policies;
    - WebView2's browser process lacks `--host-resolver-rules` (§10);
    - `Get-NetTCPConnection` or `Get-NetUDPEndpoint`, sampled twice a second, shows
      any socket owned by efre or by those processes, loopback included. Each
      observation names the owning process type;
    - the window, read through UI Automation, doesn't show one of efre's screen
      headings, such as "Welcome to efre" on a fresh runner. That confirms the page
      loads and its IPC works under the hardening and the host resolver rule.
      "efre couldn't start" is reported as an IPC failure;
    - `Get-ProcessMitigation` reports an image-load policy as `OFF`;
    - the per-user WER exclusion value is missing.

    Without a usable `webauthn.dll`, the app shows its "unsupported" screen and
    keeps running, which is enough for this test.
  - an installer test. A silent install must land in `%LOCALAPPDATA%\Programs\efre`,
    with nothing in `%LOCALAPPDATA%\efre`. A silent uninstall must then leave a
    stand-in `vault.efre` byte-identical, keep the `webview` folder, and remove
    the WER exclusion value.

  Both tests live in `scripts/ci/` (`smoke-test.ps1`, `installer-test.ps1`), and the
  release workflow (§9) runs them too.
  - They refuse to run outside GitHub Actions.
  - The installer test also refuses to run where a `vault.efre` already exists,
    because it writes a stand-in one.

  An extra `ubuntu-latest` job runs the `efre-core` and `efre-authn` tests to
  prove they are platform-independent.
- **Hardware (phase 3):** `cargo run -p efre-core --example hardware_check` on
  Windows with two real YubiKeys, following `docs/HARDWARE_TESTS.md`. The
  example never touches `%LOCALAPPDATA%\efre`.
- **Phase 3 unit tests** cover:
  - the authenticator-data parser and every registration and assertion rule;
  - a real YubiKey 5Ci packed attestation (from webauthn-rs, MPL-2.0) that
    verifies, and is rejected after any tampering, with the wrong anchors, or
    outside its validity period;
  - client-data JSON and base64url (RFC 4648 vectors);
  - HRESULT mapping;
  - presence-path parsing;
  - parsers that never panic.
- **Tests (phase 2):** `cargo test -p efre-core -p efre-authn`.
  - **Unit tests:**
    - KEK and subkeys checked against an independent HKDF computation;
    - every AEAD binding (key, vault id, slot or record id, version, each
      nonce and ciphertext byte) failing closed;
    - padding edges;
    - header byte layout and strictness;
    - payload validation;
    - redacted `Debug`.
  - **`tests/vault_flows.rs`:**
    - wizard, unlock with either key, and every unlock outcome (no key,
      unknown key, cancel, timeout, wrong PIN, PIN blocked → backup key);
    - secrets withheld until revealed;
    - item lifecycle;
    - settings;
    - add key (D2, including a walk-up attacker's own key);
    - rename;
    - remove with VMK rotation, including a cancellation part-way through
      that leaves the file byte-identical;
    - last-key protection.
  - **`tests/tamper.rs`:** each of these fails closed:
    - every header byte;
    - the header and manifest MACs;
    - downgrade and future versions, refused before any prompt;
    - ciphertext, tag and nonce edits, deletion, swap, extension and truncation;
    - single-record rollback;
    - records, headers and slots from another vault;
    - extra tables, indexes or views, a foreign `application_id`, damaged
      pages, and non-SQLite files.
  - **Property tests:**
    - header and payload round-trips, and decoders that never panic;
    - any single bit flip in a record fails;
    - any bit flipped anywhere in the file either makes efre refuse it or
      leaves the contents unchanged.

## 12. Dependencies and why

Versions are as of 2026-10-31. Every one was checked as current and actively
published.

### Rust
| Crate | Version | Where | Why |
|---|---|---|---|
| `chacha20poly1305` | 0.11 | core | XChaCha20-Poly1305 AEAD (RustCrypto) |
| `hkdf` | 0.13 | core | HKDF-SHA256 |
| `sha2` | 0.11 | core, authn | SHA-256 |
| `hmac` | 0.13 | core, authn (mock) | HMAC-SHA256 header/manifest MAC, mock PRF |
| `rand` | 0.10 | core, authn (Windows) | OS CSPRNG (vault keys, nonces, salts; WebAuthn challenges) |
| `zeroize` | 1.9 | all | Wipe secrets on drop |
| `secrecy` | 0.10 | core, app | `SecretBox` with redacted Debug |
| `subtle` | 2.6 | core | Constant-time compares (VMK equality in §6.3) |
| `rusqlite` (`bundled`) | 0.41 | core | SQLite storage with a pinned engine |
| `minicbor` (+ derive) | 2.x | core, authn | Record payload encoding, and parsing the CBOR in authData and attestation. One small no_std codec instead of two. Licensed BlueOak-1.0.0 (permissive, OSI-approved; allowed in `deny.toml`). |
| `thiserror` | 2 | all | Error enums. They never carry secret data. |
| `windows` | 0.62 | authn, app | Win32 bindings: WebAuthn types, `LoadLibraryExW`, windows/power/session/device notifications, clipboard sequence, `VirtualLock`, and the startup hardening (error mode, DLL directories, image-load policy, WER exclusion, environment) |
| `rustls-webpki` (+ `ring`) | 0.103 | authn | X.509 path validation for YubiKey attestation, and ES256 signature verification. This is a widely deployed, well-reviewed verifier; we don't hand-write chain validation. It is pure verification with no network, revocation or TLS (`rustls` itself stays banned). It accepts a real YubiKey 5Ci attestation under its normal rules. The one customisation is that EKU is not required. |
| `rustls-pki-types` | 1.15 | authn | Certificate and time types for rustls-webpki, without default features. It is already in the graph through rustls-webpki. |
| `arboard` | 3.7 | app | Clipboard with Windows history/cloud/monitoring exclusions |
| `tauri` | 2.12 | app | App shell, without the devtools feature |
| `tauri-build` | 2.x | app (build) | Required by Tauri |
| `tauri-plugin-single-instance` | 2.5 | app | Single instance. It uses local IPC only, no network. |
| `webview2-com` | 0.39 | app (Windows) | The two WebView2 settings Tauri doesn't expose: browser accelerator keys and the default context menu. Already in the graph through tauri/wry at the same version. |
| `serde`, `serde_json` | 1 | app | IPC payloads (already required by Tauri) |
| `proptest` | 1.12 | dev | Property tests. Temporary directories in tests use a small std-only helper rather than another crate. |

### Frontend (bundled locally; no CDN)
| Package | Why |
|---|---|
| `react`, `react-dom` 19 | UI |
| `typescript` 6.0 (strict) | Types. 6.0 rather than 7.x because `typescript-eslint` supports < 6.1. |
| `vite` 8, `@vitejs/plugin-react` | Build and dev server (localhost only, dev only) |
| `tailwindcss` 4, `@tailwindcss/vite` | Styling |
| shadcn/ui → `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge` | Accessible primitives. shadcn components are copied into `src/components/ui`. |
| `cmdk` | Ctrl+K command palette |
| `motion` | 150–200 ms animations, respecting `prefers-reduced-motion` |
| `lucide-react` | Icons, as tree-shaken SVG components |
| `@fontsource-variable/inter` | Bundled Inter variable font |
| `@fontsource/noto-sans-tifinagh` | Bundled Tifinagh subset (18 KB, OFL) for the name ⵉⴼⵔⵉ (*ifri*, "cave" in Tamazight). Windows' Ebrima is the fallback. |
| `@tanstack/react-virtual` | Virtualized item list |
| `react-markdown` 10 | Secure-note Markdown. It renders React elements, never `innerHTML`; raw HTML is skipped, images aren't rendered, and links are plain text. |
| `@tauri-apps/api` | IPC |
| dev: `@tauri-apps/cli`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`, `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `globals` | Build, test and lint |

All frontend dependencies are pinned to exact versions. `npm audit --omit=dev` runs in
CI. None of them injects `<style>` tags or uses `eval`, as the strict CSP requires.

## 13. Repository layout
```
Cargo.toml              workspace
crates/efre-core/       vault format + crypto + storage
crates/efre-authn/      Authenticator trait; authdata.rs, attestation.rs + roots/ (pinned Yubico CAs);
                        clientdata.rs, hresult.rs; windows/ (cfg(windows) WebAuthn driver);
                        presence.rs + presence_windows.rs; mock.rs (feature "mock")
crates/efre-core/examples/hardware_check.rs   Windows hardware test tool (phase 3)
src-tauri/              Tauri app (crate "efre"); src/hardening.rs = startup hardening (§8.1)
src-tauri/windows/installer-hooks.nsh   NSIS hooks: per-user install folder (§9)
src/                    React frontend
docs/                   SPEC.md, ARCHITECTURE.md, HARDWARE_TESTS.md
deny.toml               cargo-deny policy
.github/workflows/ci.yml
```

## 14. Decisions (accepted 2026-10-31: all defaults)
| # | Question | Decision |
|---|---|---|
| D1 | If your Windows build drops hmac-secret on non-discoverable credentials, should efre refuse to enroll, or fall back to a **discoverable** credential (one passkey slot per key)? | **Refuse** and show "update Windows". |
| D2 | Should adding a key also require a fresh PIN+touch on an already-enrolled key (one more prompt)? | **Yes** |
| D3 | Add the manifest MAC (§5.8), so per-record deletion/rollback/mix-and-match is detected? | **Yes** |
| D4 | Raw hmac-secret salts via `WEBAUTHN_AUTHENTICATOR_HMAC_SECRET_VALUES_FLAG`, rather than Windows' PRF hashing? | **Raw** |
| D5 | Keep slot nicknames, dates and AAGUIDs in plaintext (MACed) so the unlock screen can name your keys, or encrypt them? | **Plaintext, MACed** |
