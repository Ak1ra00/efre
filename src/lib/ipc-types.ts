/**
 * The IPC contract between the webview and Rust, v1 (docs/IPC.md). Keep this file and
 * docs/IPC.md identical in meaning: every DTO, command, event and error code is here.
 *
 * Ids are 32-char lowercase hex strings. Times are Unix seconds.
 */

export type AppPhase = "unsupported" | "setup" | "locked" | "unlocked";
export type LockReason = "manual" | "idle" | "suspend" | "session" | "unplug";

export interface AppStatus {
  phase: AppPhase;
  /** WebAuthn API version; null if webauthn.dll is unusable. */
  apiVersion: number | null;
  /** Set when phase === "unsupported". */
  unsupportedReason: string | null;
  /** Enrolled keys (unauthenticated while locked); [] in setup. */
  keys: KeyInfo[];
  /** Keys enrolled so far by the running wizard; [] otherwise. */
  setupKeys: KeyInfo[];
  /** Exactly one key enrolled: show the persistent banner. */
  singleKeyWarning: boolean;
  /** Why the vault last locked (shown on the unlock screen). */
  lastLockReason: LockReason | null;
  /** %LOCALAPPDATA%\efre\vault.efre */
  vaultPath: string;
}

export interface KeyInfo {
  id: string;
  nickname: string;
  enrolledAt: number;
  /** UUID form. */
  aaguid: string;
}

export type ItemKind = "login" | "secureNote" | "card" | "identity" | "custom";
export type FieldKind = "text" | "hidden" | "url" | "email" | "phone" | "date" | "multiline";
export type FieldRole = "username" | "password" | "url" | "notes";

export interface ItemMeta {
  id: string;
  kind: ItemKind;
  title: string;
  /** Non-secret username field, if any (list subtitle). */
  username: string | null;
  tags: string[];
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  hasPassword: boolean;
}

export interface FieldView {
  id: number;
  label: string;
  kind: FieldKind;
  role: FieldRole | null;
  /** null for "hidden" fields: use reveal_field. */
  value: string | null;
}

export interface ItemView {
  meta: ItemMeta;
  fields: FieldView[];
}

/** "keep" only for existing field ids: Rust keeps the stored value (secrets never round-trip). */
export type DraftValue = "keep" | { set: string };

export interface FieldDraft {
  id: number | null;
  label: string;
  kind: FieldKind;
  role: FieldRole | null;
  value: DraftValue;
}

export interface ItemDraft {
  kind: ItemKind;
  title: string;
  favorite: boolean;
  tags: string[];
  fields: FieldDraft[];
}

export interface Settings {
  /** 1..=120 */
  autoLockMinutes: number;
  /** 5..=300 */
  clipboardClearSeconds: number;
}

export interface CopyResult {
  clearsInSeconds: number;
}

export interface PasswordOptions {
  /** 8..=128 */
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  avoidAmbiguous: boolean;
}

export interface PassphraseOptions {
  /** 3..=12 */
  words: number;
  /** 0..=3 chars */
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export interface Generated {
  value: string;
  entropyBits: number;
}

export interface SecurityInfo {
  appVersion: string;
  formatVersion: number;
  webauthnApiVersion: number | null;
  vaultPath: string;
  keyCount: number;
  /** Human-readable, e.g. "Screen capture blocked". */
  protections: string[];
  /** Honest limits (SECURITY.md summary). */
  limits: string[];
}

export type KeyStep =
  /** Confirm with any enrolled key. */
  | { step: "useEnrolledKey"; nickname: null }
  /** New key: create its credential. */
  | { step: "createCredential"; nickname: null }
  /** New key: same key again. */
  | { step: "confirmNewKey"; nickname: null }
  /** This specific enrolled key (rotation). */
  | { step: "useKey"; nickname: string };

export interface LockedEvent {
  reason: LockReason;
}

/** Every command: its arguments (camelCase keys) and its result. `undefined` = no arguments. */
export interface IpcCommands {
  app_status: { args: undefined; result: AppStatus };
  setup_start: { args: undefined; result: AppStatus };
  setup_enroll_key: { args: { nickname: string }; result: KeyInfo };
  setup_finish: { args: undefined; result: AppStatus };
  setup_cancel: { args: undefined; result: AppStatus };
  unlock: { args: undefined; result: AppStatus };
  lock: { args: undefined; result: null };
  cancel_prompt: { args: undefined; result: null };
  activity: { args: undefined; result: null };
  list_items: { args: undefined; result: ItemMeta[] };
  get_item: { args: { id: string }; result: ItemView };
  create_item: { args: { draft: ItemDraft }; result: ItemMeta };
  update_item: { args: { id: string; draft: ItemDraft }; result: ItemMeta };
  set_favorite: { args: { id: string; favorite: boolean }; result: ItemMeta };
  trash_item: { args: { id: string }; result: ItemMeta };
  restore_item: { args: { id: string }; result: ItemMeta };
  delete_item: { args: { id: string }; result: null };
  empty_trash: { args: undefined; result: number };
  reveal_field: { args: { id: string; fieldId: number }; result: string };
  copy_field: { args: { id: string; fieldId: number }; result: CopyResult };
  copy_role: { args: { id: string; role: FieldRole }; result: CopyResult };
  generate_password: { args: { options: PasswordOptions }; result: Generated };
  generate_passphrase: { args: { options: PassphraseOptions }; result: Generated };
  copy_generated: { args: undefined; result: CopyResult };
  get_settings: { args: undefined; result: Settings };
  set_settings: { args: { settings: Settings }; result: Settings };
  list_keys: { args: undefined; result: KeyInfo[] };
  add_key: { args: { nickname: string }; result: KeyInfo };
  rename_key: { args: { id: string; nickname: string }; result: KeyInfo };
  remove_key: { args: { id: string }; result: KeyInfo[] };
  open_vault_folder: { args: undefined; result: null };
  security_info: { args: undefined; result: SecurityInfo };
}

export type CommandName = keyof IpcCommands;
export type CommandArgs<C extends CommandName> = IpcCommands[C]["args"];
export type CommandResult<C extends CommandName> = IpcCommands[C]["result"];

/** Every command name, at runtime (the `satisfies` keeps it exhaustive). */
export const COMMAND_NAMES = Object.keys({
  app_status: true,
  setup_start: true,
  setup_enroll_key: true,
  setup_finish: true,
  setup_cancel: true,
  unlock: true,
  lock: true,
  cancel_prompt: true,
  activity: true,
  list_items: true,
  get_item: true,
  create_item: true,
  update_item: true,
  set_favorite: true,
  trash_item: true,
  restore_item: true,
  delete_item: true,
  empty_trash: true,
  reveal_field: true,
  copy_field: true,
  copy_role: true,
  generate_password: true,
  generate_passphrase: true,
  copy_generated: true,
  get_settings: true,
  set_settings: true,
  list_keys: true,
  add_key: true,
  rename_key: true,
  remove_key: true,
  open_vault_folder: true,
  security_info: true,
} satisfies Record<CommandName, true>) as CommandName[];

/** Commands that show Windows Security prompts (each preceded by a `key-step` event). */
export const PROMPTING_COMMANDS = [
  "setup_enroll_key",
  "unlock",
  "add_key",
  "rename_key",
  "remove_key",
] as const satisfies readonly CommandName[];

/** Rust → webview events and their payloads. */
export interface IpcEvents {
  "key-step": KeyStep;
  locked: LockedEvent;
}
export type EventName = keyof IpcEvents;

export const IPC_ERROR_CODES = [
  // General
  "locked",
  "notFound",
  "invalid",
  "internal",
  "clipboard",
  // Authenticator
  "authn.cancelled",
  "authn.timeout",
  "authn.noDevice",
  "authn.unknownKey",
  "authn.alreadyEnrolled",
  "authn.wrongPin",
  "authn.pinBlocked",
  "authn.pinNotSet",
  "authn.unsupportedPlatform",
  "authn.attestationRejected",
  "authn.noSecret",
  "authn.invalidResponse",
  "authn.platform",
  // Vault
  "vault.keyRejected",
  "vault.tampered",
  "vault.corrupt",
  "vault.notAVault",
  "vault.tooNew",
  "vault.unsupportedVersion",
  "vault.notFound",
  "vault.alreadyExists",
  "vault.inUse",
  "vault.lastKey",
  "vault.tooManyKeys",
  "vault.notInTrash",
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

/** An error as Rust serializes it. `message` is user-facing English with no secrets. */
export interface IpcErrorPayload {
  code: string;
  message: string;
}
