/**
 * Typed wrappers for every command and event in docs/IPC.md. This is the only module
 * that talks to Rust: UI code calls `ipc.*` and `listenEvent`, never `invoke`/`listen`
 * directly (ESLint enforces it).
 *
 * Every command either resolves with its typed result or rejects with an `IpcError`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  FieldRole,
  IpcErrorCode,
  IpcErrorPayload,
  IpcEvents,
  ItemDraft,
  KeyStep,
  LockedEvent,
  PassphraseOptions,
  PasswordOptions,
  Settings,
} from "./ipc-types";

export type { UnlistenFn };

/** A failed command. `code` is stable (docs/IPC.md); `message` is safe to show. */
export class IpcError extends Error {
  readonly code: IpcErrorCode | (string & {});

  constructor(code: IpcErrorCode | (string & {}), message: string) {
    super(message);
    this.name = "IpcError";
    this.code = code;
  }
}

function isErrorPayload(value: unknown): value is IpcErrorPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["code"] === "string" && typeof record["message"] === "string";
}

/** True for any error that came back from a command (normalized or raw wire payload). */
export function isIpcError(err: unknown): err is Pick<IpcError, "code" | "message"> {
  return err instanceof IpcError || isErrorPayload(err);
}

/** The error code, or null if `err` is not a command error. */
export function ipcErrorCode(err: unknown): IpcErrorCode | (string & {}) | null {
  return isIpcError(err) ? err.code : null;
}

/** Normalizes whatever `invoke` rejected with into an IpcError. */
export function toIpcError(raw: unknown): IpcError {
  if (raw instanceof IpcError) return raw;
  if (isErrorPayload(raw)) return new IpcError(raw.code, raw.message);
  // Tauri itself rejects with plain strings (unknown command, missing permission, ...).
  if (typeof raw === "string") return new IpcError("internal", raw);
  if (raw instanceof Error) return new IpcError("internal", raw.message);
  return new IpcError("internal", "Unknown error");
}

async function call<C extends CommandName>(
  cmd: C,
  ...args: CommandArgs<C> extends undefined ? [] : [CommandArgs<C>]
): Promise<CommandResult<C>> {
  try {
    const [payload] = args;
    return await invoke<CommandResult<C>>(cmd, payload ?? {});
  } catch (raw: unknown) {
    throw toIpcError(raw);
  }
}

/** One typed function per command. Commands marked "prompts" are long-running. */
export const ipc = {
  appStatus: () => call("app_status"),
  setupStart: () => call("setup_start"),
  /** Prompts twice: `createCredential`, `confirmNewKey`. */
  setupEnrollKey: (nickname: string) => call("setup_enroll_key", { nickname }),
  setupFinish: () => call("setup_finish"),
  setupCancel: () => call("setup_cancel"),
  /** Prompts once: `useEnrolledKey`. */
  unlock: () => call("unlock"),
  /** Rust reloads the webview afterwards. */
  lock: () => call("lock"),
  /** Closes an open Windows Security prompt; the running command rejects with `authn.cancelled`. */
  cancelPrompt: () => call("cancel_prompt"),
  /** Resets the idle timer. */
  activity: () => call("activity"),
  /** Includes trashed items. */
  listItems: () => call("list_items"),
  getItem: (id: string) => call("get_item", { id }),
  createItem: (draft: ItemDraft) => call("create_item", { draft }),
  updateItem: (id: string, draft: ItemDraft) => call("update_item", { id, draft }),
  setFavorite: (id: string, favorite: boolean) => call("set_favorite", { id, favorite }),
  trashItem: (id: string) => call("trash_item", { id }),
  restoreItem: (id: string) => call("restore_item", { id }),
  /** The item must be in the trash. */
  deleteItem: (id: string) => call("delete_item", { id }),
  /** Resolves with the number of deleted items. */
  emptyTrash: () => call("empty_trash"),
  /** The only way a secret value reaches JS: an explicit user action. Re-hide it after 10 s. */
  revealField: (id: string, fieldId: number) => call("reveal_field", { id, fieldId }),
  /** Copies in Rust; the value never enters JS. */
  copyField: (id: string, fieldId: number) => call("copy_field", { id, fieldId }),
  /** Copies the field with this role (Ctrl+C password, Ctrl+B username); `notFound` if absent. */
  copyRole: (id: string, role: FieldRole) => call("copy_role", { id, role }),
  generatePassword: (options: PasswordOptions) => call("generate_password", { options }),
  generatePassphrase: (options: PassphraseOptions) => call("generate_passphrase", { options }),
  /** Copies the last generated value, which Rust keeps. */
  copyGenerated: () => call("copy_generated"),
  getSettings: () => call("get_settings"),
  setSettings: (settings: Settings) => call("set_settings", { settings }),
  listKeys: () => call("list_keys"),
  /** Prompts three times: `useEnrolledKey`, `createCredential`, `confirmNewKey`. */
  addKey: (nickname: string) => call("add_key", { nickname }),
  /** Prompts once: `useEnrolledKey`. */
  renameKey: (id: string, nickname: string) => call("rename_key", { id, nickname }),
  /** Prompts once per remaining key (`useKey`); rotates the vault key. Resolves with the remaining keys. */
  removeKey: (id: string) => call("remove_key", { id }),
  openVaultFolder: () => call("open_vault_folder"),
  securityInfo: () => call("security_info"),
} as const;

/** Subscribes to a Rust → webview event. Resolves with the unsubscribe function. */
export async function listenEvent<E extends EventName>(
  event: E,
  handler: (payload: IpcEvents[E]) => void,
): Promise<UnlistenFn> {
  return listen<IpcEvents[E]>(event, (e) => {
    handler(e.payload);
  });
}

/** Right before each Windows Security prompt. */
export const onKeyStep = (handler: (step: KeyStep) => void) => listenEvent("key-step", handler);

/** The vault locked. Rust reloads the webview right after. */
export const onLocked = (handler: (event: LockedEvent) => void) => listenEvent("locked", handler);

/* ----------------------------------------------------------------------------------- */
/* UI copy                                                                              */
/* ----------------------------------------------------------------------------------- */

export interface FriendlyError {
  code: string;
  title: string;
  description: string;
}

type Copy = Omit<FriendlyError, "code">;

const CANCELLED_COPY: Copy = {
  title: "Cancelled",
  description:
    "The Windows Security prompt was closed. If Windows said it didn't recognise this key, it isn't enrolled in this vault: try your other key.",
};

const COPY: Record<IpcErrorCode, Copy> = {
  locked: { title: "The vault is locked", description: "Unlock it with your YubiKey to continue." },
  notFound: {
    title: "Not found",
    description: "That item or field no longer exists. It may have been deleted.",
  },
  invalid: { title: "Check your input", description: "Something wasn't valid. Check it and try again." },
  internal: {
    title: "Something went wrong",
    description: "efre hit an unexpected problem. Try again, and restart efre if it keeps happening.",
  },
  clipboard: {
    title: "Couldn't copy",
    description: "Windows didn't let efre use the clipboard. Try again in a moment.",
  },
  "authn.cancelled": CANCELLED_COPY,
  "authn.timeout": {
    title: "Timed out",
    description: "efre waited too long for your YubiKey. Try again, and touch the key when it blinks.",
  },
  "authn.noDevice": {
    title: "No YubiKey found",
    description: "Plug your YubiKey into a USB port, then try again.",
  },
  "authn.unknownKey": {
    title: "This key isn't enrolled",
    description: "This YubiKey can't open this vault. Try your other key.",
  },
  "authn.alreadyEnrolled": {
    title: "Already enrolled",
    description: "This YubiKey is already enrolled in this vault. Insert a different one.",
  },
  "authn.wrongPin": {
    title: "Wrong PIN",
    description:
      "That PIN wasn't right. Take care: after too many wrong tries the YubiKey blocks its PIN.",
  },
  "authn.pinBlocked": {
    title: "PIN blocked",
    description: "This key's PIN is blocked. Use your backup key, then remove this one in Settings.",
  },
  "authn.pinNotSet": {
    title: "Set a PIN first",
    description:
      "This YubiKey has no FIDO2 PIN yet. In Windows Settings, open Accounts › Sign-in options › Security key › Manage, set a PIN, then try again.",
  },
  "authn.unsupportedPlatform": {
    title: "Update Windows",
    description:
      "This version of Windows can't give efre the key secret it needs (hmac-secret). Install the latest Windows updates, then try again.",
  },
  "authn.attestationRejected": {
    title: "Not a genuine YubiKey",
    description: "efre only accepts YubiKeys, and this security key couldn't be verified as one.",
  },
  "authn.noSecret": {
    title: "The key returned no secret",
    description: "This key didn't return the secret efre needs. Try again, or use a YubiKey with FIDO2.",
  },
  "authn.invalidResponse": {
    title: "Unexpected response",
    description: "Windows or the key answered in a way efre couldn't verify. Try again.",
  },
  "authn.platform": {
    title: "Windows reported an error",
    description: "Windows Security couldn't finish. Try again, and restart your PC if it keeps happening.",
  },
  "vault.keyRejected": {
    title: "This key can't open the vault",
    description: "The key answered, but its secret doesn't unlock this vault. Try your other key.",
  },
  "vault.tampered": {
    title: "The vault failed its integrity check",
    description:
      "vault.efre was changed outside efre, so efre refuses to open it. Restore a copy you trust.",
  },
  "vault.corrupt": {
    title: "The vault file is damaged",
    description: "efre can't read vault.efre. Restore a copy you trust.",
  },
  "vault.notAVault": {
    title: "Not an efre vault",
    description: "The file at the vault location isn't an efre vault.",
  },
  "vault.tooNew": {
    title: "Made by a newer efre",
    description: "This vault was created by a newer version of efre. Update efre to open it.",
  },
  "vault.unsupportedVersion": {
    title: "Unsupported vault format",
    description: "This vault uses a format this version of efre won't open.",
  },
  "vault.notFound": {
    title: "No vault found",
    description: "There's no vault at the usual location.",
  },
  "vault.alreadyExists": {
    title: "A vault already exists",
    description: "efre never overwrites a vault, so setup stopped. Your existing vault is untouched.",
  },
  "vault.inUse": {
    title: "The vault is in use",
    description: "Another program has vault.efre open. Close it, then try again.",
  },
  "vault.lastKey": {
    title: "That's your last key",
    description: "Enroll another YubiKey before removing this one.",
  },
  "vault.tooManyKeys": {
    title: "Too many keys",
    description: "This vault already has the most keys it can hold. Remove one first.",
  },
  "vault.notInTrash": {
    title: "Not in the trash",
    description: "Move the item to the trash before deleting it for good.",
  },
};

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return trimmed;
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function isKnownCode(code: string): code is IpcErrorCode {
  return Object.hasOwn(COPY, code);
}

/** UI copy for any error a command can produce (and for unexpected JS errors). */
export function friendlyError(err: unknown): FriendlyError {
  const e = isIpcError(err) ? err : toIpcError(err);
  if (!isKnownCode(e.code)) {
    return {
      code: e.code,
      title: "Something went wrong",
      description: e.message.trim() === "" ? COPY.internal.description : sentence(e.message),
    };
  }
  const copy = COPY[e.code];
  if (e.code === "invalid" && e.message.trim() !== "") {
    // Rust's message names the field that failed validation.
    return { code: e.code, title: copy.title, description: sentence(e.message) };
  }
  if (e.code === "authn.platform") {
    const hex = /0x[0-9a-f]{1,8}/i.exec(e.message)?.[0];
    if (hex !== undefined) {
      return {
        code: e.code,
        title: copy.title,
        description: `Windows Security reported error ${hex}. Try again, and restart your PC if it keeps happening.`,
      };
    }
  }
  return { code: e.code, ...copy };
}

/** What to tell the user before each Windows Security prompt. */
export function describeKeyStep(step: KeyStep): { title: string; description: string } {
  switch (step.step) {
    case "useEnrolledKey":
      return {
        title: "Confirm with your YubiKey",
        description: "Insert one of your enrolled keys. Windows will ask for its PIN, then a touch.",
      };
    case "createCredential":
      return {
        title: "Insert the new YubiKey",
        description: "Windows will ask for its PIN, then a touch. This registers the key with efre.",
      };
    case "confirmNewKey":
      return {
        title: "Touch the new key again",
        description: "One more PIN and touch links this key to your vault.",
      };
    case "useKey":
      return {
        title: `Use “${step.nickname}”`,
        description: "Insert this key. Windows will ask for its PIN, then a touch.",
      };
  }
}
