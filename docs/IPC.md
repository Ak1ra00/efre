# efre — IPC contract (webview ⇄ Rust), v1

The only boundary between the React UI and Rust. Both sides implement exactly this.
Security rules: ARCHITECTURE §8.3 and AGENTS.md. Keys, PRF outputs and KEKs never
cross this boundary. Secret field values reach JS only through `reveal_field` (an
explicit user action) and when the user types them. Copying is always done in Rust.

## Conventions
- Commands are Tauri commands, invoked as `invoke("<snake_case_name>", { ...args })`.
  JS argument keys are camelCase; Tauri maps them to snake_case Rust parameters.
- Every DTO is serialized with `#[serde(rename_all = "camelCase")]`, and enums use
  the string values listed below.
- Ids are lowercase hex strings (32 chars). Times are Unix seconds (number).
- Every command returns `Result<T, IpcError>`. An error serializes as
  `{ "code": string, "message": string }`.
  - `message` is user-facing English with no secrets.
  - The UI may replace it with its own copy, keyed by `code`.
- Commands that show a Windows Security prompt are **long-running**: they block until
  the user finishes. Rust runs them off the UI thread. Before **each** prompt, Rust
  emits a `key-step` event.

## Types (TypeScript notation)
```ts
type AppPhase = "unsupported" | "setup" | "locked" | "unlocked";
type LockReason = "manual" | "idle" | "suspend" | "session" | "unplug";

interface AppStatus {
  phase: AppPhase;
  apiVersion: number | null;          // WebAuthn API version; null if webauthn.dll is unusable
  unsupportedReason: string | null;   // set when phase === "unsupported"
  keys: KeyInfo[];                    // enrolled keys (unauthenticated while locked); [] in setup
  setupKeys: KeyInfo[];               // keys enrolled so far by the running wizard; [] otherwise
  singleKeyWarning: boolean;          // exactly one key enrolled: show the persistent banner
  lastLockReason: LockReason | null;  // why the vault last locked (shown on the unlock screen)
  vaultPath: string;                  // %LOCALAPPDATA%\efre\vault.efre
}
interface KeyInfo { id: string; nickname: string; enrolledAt: number; aaguid: string /* uuid form */ }

type ItemKind = "login" | "secureNote" | "card" | "identity" | "custom";
type FieldKind = "text" | "hidden" | "url" | "email" | "phone" | "date" | "multiline";
type FieldRole = "username" | "password" | "url" | "notes";

interface ItemMeta {
  id: string; kind: ItemKind; title: string;
  username: string | null;            // non-secret username field, if any (list subtitle)
  tags: string[]; favorite: boolean;
  createdAt: number; updatedAt: number; trashedAt: number | null;
  hasPassword: boolean;
}
interface FieldView {
  id: number; label: string; kind: FieldKind; role: FieldRole | null;
  value: string | null;               // null for "hidden" fields: use reveal_field
}
interface ItemView { meta: ItemMeta; fields: FieldView[] }

type DraftValue = "keep" | { set: string };   // "keep" only for existing field ids
interface FieldDraft { id: number | null; label: string; kind: FieldKind; role: FieldRole | null; value: DraftValue }
interface ItemDraft { kind: ItemKind; title: string; favorite: boolean; tags: string[]; fields: FieldDraft[] }

interface Settings { autoLockMinutes: number /* 1..=120 */; clipboardClearSeconds: number /* 5..=300 */ }
interface CopyResult { clearsInSeconds: number }

interface PasswordOptions { length: number /* 8..=128 */; lowercase: boolean; uppercase: boolean; digits: boolean; symbols: boolean; avoidAmbiguous: boolean }
interface PassphraseOptions { words: number /* 3..=12 */; separator: string /* 0..=3 chars */; capitalize: boolean; includeNumber: boolean }
interface Generated { value: string; entropyBits: number }

interface SecurityInfo {
  appVersion: string; formatVersion: number; webauthnApiVersion: number | null;
  vaultPath: string; keyCount: number;
  protections: string[];              // human-readable, e.g. "Screen capture blocked"
  limits: string[];                   // honest limits (SECURITY.md summary)
}

type KeyStep =
  | { step: "useEnrolledKey"; nickname: null }      // confirm with any enrolled key
  | { step: "createCredential"; nickname: null }    // new key: create its credential
  | { step: "confirmNewKey"; nickname: null }       // new key: same key again
  | { step: "useKey"; nickname: string };           // this specific enrolled key (rotation)
```

Defaults the UI uses:
- **Password:** length 20, all four classes on, `avoidAmbiguous` false.
- **Passphrase:** 6 words, separator `-`, no capitals, no number.
- **Strength label from `entropyBits`:** under 50 is "Weak", under 70 is "Fair",
  under 100 is "Strong", and 100 or more is "Very strong".
- **Presets:**
  - auto-lock: 1, 2, 5, 10, 15, 30, 60 or 120 minutes;
  - clipboard clear: 10, 20, 30, 45, 60, 90 or 120 seconds.

## Commands
Column "Prompts" is the number of Windows Security prompts. "Phase" is the phase the
command needs; outside it, the command fails with `locked` or `invalid`.

| Command | Args | Returns | Phase | Prompts |
|---|---|---|---|---|
| `app_status` | — | `AppStatus` | any | 0 |
| `setup_start` | — | `AppStatus` | setup | 0 |
| `setup_enroll_key` | `{ nickname }` | `KeyInfo` | setup (after start) | 2 (`createCredential`, `confirmNewKey`) |
| `setup_finish` | — | `AppStatus` (unlocked) | setup, ≥ 1 key | 0 |
| `setup_cancel` | — | `AppStatus` | setup | 0 |
| `unlock` | — | `AppStatus` | locked | 1 |
| `lock` | — | `null` (then the webview reloads) | any | 0 |
| `cancel_prompt` | — | `null` | any | 0 (closes an open Windows prompt) |
| `activity` | — | `null` | any | 0 (resets the idle timer) |
| `list_items` | — | `ItemMeta[]` (includes trashed) | unlocked | 0 |
| `get_item` | `{ id }` | `ItemView` | unlocked | 0 |
| `create_item` | `{ draft }` | `ItemMeta` | unlocked | 0 |
| `update_item` | `{ id, draft }` | `ItemMeta` | unlocked | 0 |
| `set_favorite` | `{ id, favorite }` | `ItemMeta` | unlocked | 0 |
| `trash_item` | `{ id }` | `ItemMeta` | unlocked | 0 |
| `restore_item` | `{ id }` | `ItemMeta` | unlocked | 0 |
| `delete_item` | `{ id }` | `null` (item must be in trash) | unlocked | 0 |
| `empty_trash` | — | `number` (deleted) | unlocked | 0 |
| `reveal_field` | `{ id, fieldId }` | `string` | unlocked | 0 |
| `copy_field` | `{ id, fieldId }` | `CopyResult` | unlocked | 0 |
| `copy_role` | `{ id, role }` | `CopyResult` (`notFound` if the item has no such field) | unlocked | 0 |
| `generate_password` | `{ options }` | `Generated` | unlocked | 0 |
| `generate_passphrase` | `{ options }` | `Generated` | unlocked | 0 |
| `copy_generated` | — | `CopyResult` (copies the last generated value, kept in Rust) | unlocked | 0 |
| `get_settings` | — | `Settings` | unlocked | 0 |
| `set_settings` | `{ settings }` | `Settings` | unlocked | 0 |
| `list_keys` | — | `KeyInfo[]` | unlocked | 0 |
| `add_key` | `{ nickname }` | `KeyInfo` | unlocked | 3 (`useEnrolledKey`, `createCredential`, `confirmNewKey`) |
| `rename_key` | `{ id, nickname }` | `KeyInfo` | unlocked | 1 (`useEnrolledKey`) |
| `remove_key` | `{ id }` | `KeyInfo[]` (remaining) | unlocked, ≥ 2 keys | 1 per remaining key (`useKey`) |
| `open_vault_folder` | — | `null` | any | 0 |
| `security_info` | — | `SecurityInfo` | any | 0 |

During `setup_enroll_key`, `add_key` and `remove_key` the "no YubiKey plugged in" lock
is suspended, so the user can swap keys (ARCHITECTURE §6.7). Every other lock trigger
stays active and cancels the prompt.

## Events (Rust → webview)
| Event | Payload | When |
|---|---|---|
| `key-step` | `KeyStep` | Right before each Windows Security prompt |
| `locked` | `{ reason: LockReason }` | The vault locked. Rust then reloads the webview, and the UI's next `app_status` shows `lastLockReason`. |

## Error codes
- **General:** `locked`, `notFound`, `invalid`, `internal`, `clipboard`.
- **From the authenticator:**
  - `authn.cancelled`, `authn.timeout`, `authn.noDevice`, `authn.unknownKey`,
    `authn.alreadyEnrolled`;
  - `authn.wrongPin`, `authn.pinBlocked`, `authn.pinNotSet`;
  - `authn.unsupportedPlatform`, `authn.attestationRejected`;
  - `authn.noSecret`, `authn.invalidResponse`, `authn.platform`.
- **From the vault:**
  - `vault.keyRejected`, `vault.tampered`, `vault.corrupt`, `vault.notAVault`;
  - `vault.tooNew`, `vault.unsupportedVersion`, `vault.notFound`,
    `vault.alreadyExists`, `vault.inUse`;
  - `vault.lastKey`, `vault.tooManyKeys`, `vault.notInTrash`.
- **UI copy notes:**
  - `authn.cancelled` must also cover "Windows said it didn't recognise this key"
    (Windows reports that as cancelled; see ARCHITECTURE §4.7).
  - `authn.unsupportedPlatform` during setup means "update Windows".
