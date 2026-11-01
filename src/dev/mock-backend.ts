/* eslint-disable @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors --
   Tauri rejects commands with plain { code, message } objects; the mock must do the same. */
/**
 * DEV ONLY. An in-browser implementation of the whole IPC contract (docs/IPC.md) for
 * `npm run dev:mock`: no Tauri, no YubiKey. It keeps an in-memory vault (never persisted),
 * two simulated keys, simulated Windows Security prompts (with `key-step` events and a
 * delay), idle auto-lock, settings and the generator. It mirrors Rust's validation so
 * inline errors can be built against it.
 *
 * It must never ship: main.tsx loads it only when MODE === "mock", and the production
 * build fails if MOCK_MARKER appears in its output.
 *
 * Scenarios come from the URL (see scenarioFromUrl), and `window.__efreMock` drives it
 * from the console or Playwright: `__efreMock.lock("idle")`, `__efreMock.failNext("authn.pinBlocked")`.
 */
import { DEFAULT_SETTINGS } from "@/lib/defaults";
import type {
  AppPhase,
  AppStatus,
  CommandArgs,
  CommandName,
  CommandResult,
  CopyResult,
  FieldRole,
  Generated,
  IpcErrorCode,
  ItemDraft,
  ItemMeta,
  ItemView,
  KeyInfo,
  KeyStep,
  LockReason,
  PassphraseOptions,
  PasswordOptions,
  Settings,
} from "@/lib/ipc-types";
import { COMMAND_NAMES, IPC_ERROR_CODES } from "@/lib/ipc-types";
import { ITEM_LIMITS } from "@/lib/items";

import { type MockField, type MockItem, randomHexId, sampleItems, sampleKeys } from "./mock-data";
import { installMockIpc, type MockIpc, wireError } from "./mock-ipc";

/** Searched for in production builds (vite.config.ts): it must never appear there. */
export const MOCK_MARKER = "efre-dev-mock-backend";

export interface MockScenario {
  phase: AppPhase;
  /** Enrolled keys for the locked/unlocked phases: 1 shows the single-key banner. */
  keys: 1 | 2;
  /** Start with an empty vault. */
  empty: boolean;
  /** Extra generated logins, to exercise the virtualized list. */
  extraItems: number;
  /** How long each simulated Windows Security prompt takes. */
  promptMs: number;
  /** Make the next prompt fail with this error. */
  fail: IpcErrorCode | null;
  lastLockReason: LockReason | null;
  /** Overrides the idle auto-lock deadline (seconds), to test the activity pinger. */
  idleSeconds: number | null;
  apiVersion: number | null;
  /** Log every command name to the console. */
  log: boolean;
}

const PHASES: readonly AppPhase[] = ["unsupported", "setup", "locked", "unlocked"];
const LOCK_REASONS: readonly LockReason[] = ["manual", "idle", "suspend", "session", "unplug"];

/**
 * `?phase=unlocked&keys=1&empty=1&items=2000&prompt=300&fail=authn.pinBlocked&reason=idle&idle=20&api=9&log=1`
 * Defaults: phase=locked, keys=2, sample items, prompt=1200 ms.
 */
export function scenarioFromUrl(search: string): MockScenario {
  const params = new URLSearchParams(search);
  const pick = <T extends string>(name: string, allowed: readonly T[]): T | null => {
    const value = params.get(name);
    return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
  };
  const number = (name: string): number | null => {
    const value = params.get(name);
    if (value === null || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const phase = pick("phase", PHASES) ?? "locked";
  return {
    phase,
    keys: params.get("keys") === "1" ? 1 : 2,
    empty: params.get("empty") === "1",
    extraItems: Math.min(number("items") ?? 0, 20_000),
    promptMs: number("prompt") ?? 1200,
    fail: pick("fail", IPC_ERROR_CODES),
    lastLockReason: pick("reason", LOCK_REASONS),
    idleSeconds: number("idle"),
    apiVersion: number("api") ?? (phase === "unsupported" ? 3 : 9),
    log: params.get("log") === "1",
  };
}

export interface MockBackend {
  marker: typeof MOCK_MARKER;
  scenario: MockScenario;
  /** Locks as Rust would (emits `locked`). The page is not reloaded: that would lose the vault. */
  lock: (reason?: LockReason) => void;
  /** The next Windows Security prompt fails with this code. */
  failNext: (code: IpcErrorCode, message?: string) => void;
  setPromptDelay: (ms: number) => void;
  /** Emits any Rust → webview event. */
  emit: MockIpc["emit"];
  uninstall: () => void;
}

const VAULT_PATH = "C:\\Users\\amastan\\AppData\\Local\\efre\\vault.efre";
const MAX_KEYS = 16;
const now = () => Math.floor(Date.now() / 1000);
const reject = (code: IpcErrorCode, message: string) => wireError(code, message);
// The control-character check mirrors Rust's `char::is_control`.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const chars = (s: string) => [...s].length;

const MESSAGES: Partial<Record<IpcErrorCode, string>> = {
  "authn.cancelled": "the operation was cancelled",
  "authn.timeout": "timed out waiting for the security key",
  "authn.noDevice": "no security key found",
  "authn.unknownKey": "this security key is not enrolled in this vault",
  "authn.alreadyEnrolled": "this security key is already enrolled",
  "authn.wrongPin": "incorrect PIN",
  "authn.pinBlocked": "the security key's PIN is blocked",
  "authn.pinNotSet": "the security key has no PIN set",
  "authn.platform": "Windows reported error 0x80090027",
  "vault.keyRejected": "this security key could not open the vault",
};

export function installMockBackend(overrides: Partial<MockScenario> = {}): MockBackend {
  const scenario: MockScenario = { ...scenarioFromUrl(""), ...overrides };
  const t0 = now();
  const initialKeys = sampleKeys(t0).slice(0, scenario.keys);

  const state = {
    phase: scenario.phase,
    keys: scenario.phase === "setup" ? ([] as KeyInfo[]) : initialKeys,
    setupKeys: [] as KeyInfo[],
    setupStarted: false,
    lastLockReason: scenario.lastLockReason,
    items: scenario.empty || scenario.phase === "setup" ? [] : sampleItems(t0, scenario.extraItems),
    settings: { ...DEFAULT_SETTINGS } as Settings,
    lastGenerated: null as string | null,
    promptMs: scenario.promptMs,
    failNext: scenario.fail === null ? null : { code: scenario.fail, message: MESSAGES[scenario.fail] ?? scenario.fail },
  };
  let pendingPrompt: { cancel: () => void } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const status = (): AppStatus => ({
    phase: state.phase,
    apiVersion: scenario.apiVersion,
    unsupportedReason:
      state.phase === "unsupported"
        ? `Windows' security key API is version ${String(scenario.apiVersion ?? "unknown")} here; efre needs version 4 or later (hmac-secret). Install the latest Windows updates.`
        : null,
    keys: state.phase === "setup" ? [] : state.keys,
    setupKeys: state.phase === "setup" ? state.setupKeys : [],
    singleKeyWarning: state.phase !== "setup" && state.keys.length === 1,
    lastLockReason: state.lastLockReason,
    vaultPath: VAULT_PATH,
  });

  // ---- lock and idle --------------------------------------------------------------

  const idleMs = () => (scenario.idleSeconds ?? state.settings.autoLockMinutes * 60) * 1000;
  const touch = () => {
    clearTimeout(idleTimer);
    if (state.phase === "unlocked") {
      idleTimer = setTimeout(() => {
        lock("idle");
      }, idleMs());
    }
  };
  const lock = (reason: LockReason = "manual") => {
    if (state.phase !== "unlocked") return;
    pendingPrompt?.cancel();
    clearTimeout(idleTimer);
    state.phase = "locked";
    state.lastLockReason = reason;
    state.lastGenerated = null;
    ipcMock.emit("locked", { reason });
  };

  // ---- simulated Windows Security prompts -------------------------------------------

  const prompt = (step: KeyStep) =>
    new Promise<void>((resolve, rejectPrompt) => {
      if (pendingPrompt !== null) {
        rejectPrompt(reject("invalid", "Another Windows Security prompt is already open."));
        return;
      }
      ipcMock.emit("key-step", step);
      const timer = setTimeout(() => {
        pendingPrompt = null;
        const failure = state.failNext;
        state.failNext = null;
        if (failure === null) resolve();
        else rejectPrompt(reject(failure.code, failure.message));
      }, state.promptMs);
      pendingPrompt = {
        cancel: () => {
          clearTimeout(timer);
          pendingPrompt = null;
          rejectPrompt(reject("authn.cancelled", MESSAGES["authn.cancelled"] ?? "cancelled"));
        },
      };
    });

  // ---- validation (mirrors efre-core) ----------------------------------------------

  const requireUnlocked = () => {
    if (state.phase === "locked") throw reject("locked", "the vault is locked");
    if (state.phase !== "unlocked") throw reject("invalid", "the vault isn't open");
    touch();
  };
  const requirePhase = (phase: AppPhase) => {
    if (state.phase !== phase) throw reject("invalid", `this needs the ${phase} phase`);
  };
  const validateNickname = (nickname: string) => {
    const n = chars(nickname);
    if (n === 0 || n > ITEM_LIMITS.nicknameChars || CONTROL.test(nickname) || nickname.trim() !== nickname) {
      throw reject("invalid", `A key nickname must be 1 to ${String(ITEM_LIMITS.nicknameChars)} characters, without spaces at either end.`);
    }
  };
  const findItem = (id: string) => {
    const item = state.items.find((i) => i.id === id);
    if (item === undefined) throw reject("notFound", "item not found");
    return item;
  };
  const findField = (item: MockItem, fieldId: number) => {
    const field = item.fields.find((f) => f.id === fieldId);
    if (field === undefined) throw reject("notFound", "field not found");
    return field;
  };
  const findKey = (id: string) => {
    const key = state.keys.find((k) => k.id === id);
    if (key === undefined) throw reject("notFound", "key not found");
    return key;
  };

  const encoder = new TextEncoder();
  const applyDraft = (draft: ItemDraft, existing: MockItem | null): { fields: MockField[]; nextFieldId: number } => {
    const title = draft.title;
    if (chars(title) === 0 || chars(title) > ITEM_LIMITS.titleChars || CONTROL.test(title)) {
      throw reject("invalid", `The title must be 1 to ${String(ITEM_LIMITS.titleChars)} characters on one line.`);
    }
    if (draft.tags.length > ITEM_LIMITS.tags) throw reject("invalid", `An item can have at most ${String(ITEM_LIMITS.tags)} tags.`);
    draft.tags.forEach((tag, i) => {
      if (chars(tag) === 0 || chars(tag) > ITEM_LIMITS.tagChars || CONTROL.test(tag)) {
        throw reject("invalid", `Tags must be 1 to ${String(ITEM_LIMITS.tagChars)} characters on one line.`);
      }
      if (draft.tags.indexOf(tag) !== i) throw reject("invalid", `The tag “${tag}” is there twice.`);
    });
    if (draft.fields.length > ITEM_LIMITS.fields) throw reject("invalid", `An item can have at most ${String(ITEM_LIMITS.fields)} fields.`);
    let nextFieldId = existing?.nextFieldId ?? 1;
    const roles = new Set<FieldRole>();
    const ids = new Set<number>();
    let total = 0;
    const fields = draft.fields.map((f): MockField => {
      if (chars(f.label) > ITEM_LIMITS.labelChars || CONTROL.test(f.label)) {
        throw reject("invalid", `Field labels must be at most ${String(ITEM_LIMITS.labelChars)} characters on one line.`);
      }
      if (f.role === "password" && f.kind !== "hidden") throw reject("invalid", "password fields must be hidden");
      if (f.role !== null) {
        if (roles.has(f.role)) throw reject("invalid", `Only one field can have the ${f.role} role.`);
        roles.add(f.role);
      }
      const previous = f.id === null ? undefined : existing?.fields.find((e) => e.id === f.id);
      if (f.id !== null && (previous === undefined || ids.has(f.id))) throw reject("invalid", "field id");
      if (f.id !== null) ids.add(f.id);
      let value: string;
      if (f.value === "keep") {
        if (previous === undefined) throw reject("invalid", "“keep” is only valid for an existing field");
        value = previous.value;
      } else {
        value = f.value.set;
      }
      const bytes = encoder.encode(value).length;
      if (bytes > ITEM_LIMITS.valueBytes) throw reject("invalid", "field value is too long");
      total += bytes;
      const id = previous?.id ?? nextFieldId++;
      return { id, label: f.label, kind: f.kind, role: f.role, value };
    });
    if (total > ITEM_LIMITS.valueBytes * 3) throw reject("invalid", "This item is too large.");
    return { fields, nextFieldId };
  };

  const meta = (item: MockItem): ItemMeta => {
    const username = item.fields.find((f) => f.role === "username" && f.kind !== "hidden")?.value ?? "";
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      username: username === "" ? null : username,
      tags: [...item.tags],
      favorite: item.favorite,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      trashedAt: item.trashedAt,
      hasPassword: item.fields.some((f) => f.role === "password"),
    };
  };
  const view = (item: MockItem): ItemView => ({
    meta: meta(item),
    fields: item.fields.map((f) => ({
      id: f.id,
      label: f.label,
      kind: f.kind,
      role: f.role,
      value: f.kind === "hidden" ? null : f.value,
    })),
  });
  const copied = (): CopyResult => ({ clearsInSeconds: state.settings.clipboardClearSeconds });

  // ---- generator ---------------------------------------------------------------------

  const randomBelow = (n: number) => {
    // Rejection sampling: no modulo bias.
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      const v = buf[0] ?? 0;
      if (v < limit) return v % n;
    }
  };
  const generatePassword = (o: PasswordOptions): Generated => {
    if (!Number.isInteger(o.length) || o.length < 8 || o.length > 128) {
      throw reject("invalid", "Password length must be 8 to 128.");
    }
    const ambiguous = /[Il1O0o|`'"]/g;
    const classes = [
      o.lowercase ? "abcdefghijklmnopqrstuvwxyz" : "",
      o.uppercase ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : "",
      o.digits ? "0123456789" : "",
      o.symbols ? "!#$%&()*+,-./:;<=>?@[]^_{}~" : "",
    ]
      .map((set) => (o.avoidAmbiguous ? set.replace(ambiguous, "") : set))
      .filter((set) => set !== "");
    if (classes.length === 0) throw reject("invalid", "Choose at least one kind of character.");
    const pool = classes.join("");
    for (;;) {
      const value = Array.from({ length: o.length }, () => pool[randomBelow(pool.length)] ?? "").join("");
      if (classes.every((set) => [...value].some((c) => set.includes(c)))) {
        return { value, entropyBits: o.length * Math.log2(pool.length) };
      }
    }
  };
  const generatePassphrase = (o: PassphraseOptions): Generated => {
    if (!Number.isInteger(o.words) || o.words < 3 || o.words > 12) throw reject("invalid", "Use 3 to 12 words.");
    if (chars(o.separator) > 3 || CONTROL.test(o.separator)) throw reject("invalid", "The separator can be at most 3 characters.");
    const words = Array.from({ length: o.words }, () => {
      const word = WORDS[randomBelow(WORDS.length)] ?? "word";
      return o.capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    });
    if (o.includeNumber) {
      const at = randomBelow(words.length);
      words[at] = `${words[at] ?? ""}${String(randomBelow(10))}`;
    }
    // Rust draws from the EFF long list (7776 words); report the entropy it would.
    const entropyBits = o.words * Math.log2(7776) + (o.includeNumber ? Math.log2(10 * o.words) : 0);
    return { value: words.join(o.separator), entropyBits };
  };
  const remember = (generated: Generated) => {
    state.lastGenerated = generated.value;
    return generated;
  };

  // ---- commands ----------------------------------------------------------------------

  type Handlers = { [C in CommandName]: (args: CommandArgs<C>) => CommandResult<C> | Promise<CommandResult<C>> };

  const newKey = (nickname: string): KeyInfo => ({
    id: randomHexId(),
    nickname,
    enrolledAt: now(),
    aaguid: "a25342c0-3cdc-4414-8e46-f4807fca511c",
  });

  const handlers: Handlers = {
    app_status: () => status(),
    setup_start: () => {
      requirePhase("setup");
      state.setupStarted = true;
      state.setupKeys = [];
      return status();
    },
    setup_enroll_key: async ({ nickname }) => {
      requirePhase("setup");
      if (!state.setupStarted) throw reject("invalid", "Start setup first.");
      validateNickname(nickname);
      if (state.setupKeys.length >= MAX_KEYS) throw reject("vault.tooManyKeys", "too many enrolled keys");
      await prompt({ step: "createCredential", nickname: null });
      await prompt({ step: "confirmNewKey", nickname: null });
      const key = newKey(nickname);
      state.setupKeys = [...state.setupKeys, key];
      return key;
    },
    setup_finish: () => {
      requirePhase("setup");
      if (state.setupKeys.length === 0) throw reject("invalid", "Enroll at least one key first.");
      state.keys = state.setupKeys;
      state.setupKeys = [];
      state.setupStarted = false;
      state.items = [];
      state.settings = { ...DEFAULT_SETTINGS };
      state.phase = "unlocked";
      touch();
      return status();
    },
    setup_cancel: () => {
      requirePhase("setup");
      state.setupStarted = false;
      state.setupKeys = [];
      return status();
    },
    unlock: async () => {
      requirePhase("locked");
      await prompt({ step: "useEnrolledKey", nickname: null });
      state.phase = "unlocked";
      touch();
      return status();
    },
    lock: () => {
      lock("manual");
      return null;
    },
    cancel_prompt: () => {
      pendingPrompt?.cancel();
      return null;
    },
    activity: () => {
      touch();
      return null;
    },
    list_items: () => {
      requireUnlocked();
      return state.items.map(meta);
    },
    get_item: ({ id }) => {
      requireUnlocked();
      return view(findItem(id));
    },
    create_item: ({ draft }) => {
      requireUnlocked();
      const { fields, nextFieldId } = applyDraft(draft, null);
      const t = now();
      const item: MockItem = {
        id: randomHexId(),
        kind: draft.kind,
        title: draft.title,
        favorite: draft.favorite,
        tags: [...draft.tags],
        createdAt: t,
        updatedAt: t,
        trashedAt: null,
        fields,
        nextFieldId,
      };
      state.items = [...state.items, item];
      return meta(item);
    },
    update_item: ({ id, draft }) => {
      requireUnlocked();
      const item = findItem(id);
      const { fields, nextFieldId } = applyDraft(draft, item);
      Object.assign(item, {
        kind: draft.kind,
        title: draft.title,
        favorite: draft.favorite,
        tags: [...draft.tags],
        fields,
        nextFieldId,
        updatedAt: Math.max(now(), item.createdAt),
      });
      return meta(item);
    },
    set_favorite: ({ id, favorite }) => {
      requireUnlocked();
      const item = findItem(id);
      item.favorite = favorite;
      return meta(item);
    },
    trash_item: ({ id }) => {
      requireUnlocked();
      const item = findItem(id);
      item.trashedAt ??= now();
      return meta(item);
    },
    restore_item: ({ id }) => {
      requireUnlocked();
      const item = findItem(id);
      item.trashedAt = null;
      return meta(item);
    },
    delete_item: ({ id }) => {
      requireUnlocked();
      const item = findItem(id);
      if (item.trashedAt === null) throw reject("vault.notInTrash", "the item must be in the trash first");
      state.items = state.items.filter((i) => i !== item);
      return null;
    },
    empty_trash: () => {
      requireUnlocked();
      const before = state.items.length;
      state.items = state.items.filter((i) => i.trashedAt === null);
      return before - state.items.length;
    },
    reveal_field: ({ id, fieldId }) => {
      requireUnlocked();
      return findField(findItem(id), fieldId).value;
    },
    copy_field: ({ id, fieldId }) => {
      requireUnlocked();
      findField(findItem(id), fieldId);
      return copied();
    },
    copy_role: ({ id, role }) => {
      requireUnlocked();
      if (!findItem(id).fields.some((f) => f.role === role)) throw reject("notFound", `this item has no ${role}`);
      return copied();
    },
    generate_password: ({ options }) => {
      requireUnlocked();
      return remember(generatePassword(options));
    },
    generate_passphrase: ({ options }) => {
      requireUnlocked();
      return remember(generatePassphrase(options));
    },
    copy_generated: () => {
      requireUnlocked();
      if (state.lastGenerated === null) throw reject("invalid", "Generate a value first.");
      return copied();
    },
    get_settings: () => {
      requireUnlocked();
      return { ...state.settings };
    },
    set_settings: ({ settings }) => {
      requireUnlocked();
      const { autoLockMinutes: a, clipboardClearSeconds: c } = settings;
      if (!Number.isInteger(a) || a < 1 || a > 120) throw reject("invalid", "Auto-lock must be 1 to 120 minutes.");
      if (!Number.isInteger(c) || c < 5 || c > 300) throw reject("invalid", "Clipboard clearing must be 5 to 300 seconds.");
      state.settings = { autoLockMinutes: a, clipboardClearSeconds: c };
      touch();
      return { ...state.settings };
    },
    list_keys: () => {
      requireUnlocked();
      return [...state.keys];
    },
    add_key: async ({ nickname }) => {
      requireUnlocked();
      validateNickname(nickname);
      if (state.keys.length >= MAX_KEYS) throw reject("vault.tooManyKeys", "too many enrolled keys");
      await prompt({ step: "useEnrolledKey", nickname: null });
      await prompt({ step: "createCredential", nickname: null });
      await prompt({ step: "confirmNewKey", nickname: null });
      const key = newKey(nickname);
      state.keys = [...state.keys, key];
      return key;
    },
    rename_key: async ({ id, nickname }) => {
      requireUnlocked();
      validateNickname(nickname);
      findKey(id);
      await prompt({ step: "useEnrolledKey", nickname: null });
      const renamed = { ...findKey(id), nickname };
      state.keys = state.keys.map((k) => (k.id === id ? renamed : k));
      return renamed;
    },
    remove_key: async ({ id }) => {
      requireUnlocked();
      findKey(id);
      if (state.keys.length < 2) throw reject("vault.lastKey", "the last enrolled key cannot be removed");
      const remaining = state.keys.filter((k) => k.id !== id);
      for (const key of remaining) await prompt({ step: "useKey", nickname: key.nickname });
      state.keys = remaining;
      return [...remaining];
    },
    open_vault_folder: () => {
      console.info(`[${MOCK_MARKER}] open_vault_folder: would open ${VAULT_PATH.replace(/\\vault\.efre$/, "")}`);
      return null;
    },
    security_info: () => ({
      appVersion: "0.1.0",
      formatVersion: 1,
      webauthnApiVersion: scenario.apiVersion,
      vaultPath: VAULT_PATH,
      keyCount: state.keys.length,
      protections: [
        "Opens only with an enrolled YubiKey: PIN or fingerprint, then touch",
        "Every item is encrypted with XChaCha20-Poly1305; the header is authenticated",
        "Screen capture blocked (content protection)",
        `Clipboard cleared after ${String(state.settings.clipboardClearSeconds)} s, and kept out of clipboard history and cloud sync`,
        `Auto-lock after ${String(state.settings.autoLockMinutes)} min idle, on sleep, on Windows lock and when no YubiKey is plugged in`,
        "Keys kept in locked memory and wiped on lock",
        "No network access",
      ],
      limits: [
        "Malware running while the vault is open can read the screen and memory",
        "Restoring an older copy of the whole vault file can't be detected",
        "A removed key still opens copies of the vault made before its removal",
        "Screen-capture blocking doesn't stop cameras or some remote-desktop tools",
      ],
    }),
  };

  const ipcMock = installMockIpc(async (cmd, args) => {
    if (!(COMMAND_NAMES as readonly string[]).includes(cmd)) {
      // Tauri rejects unknown commands with a plain string.
      throw `Command ${cmd} not found`;
    }
    if (scenario.log) console.debug(`[${MOCK_MARKER}] ${cmd}`);
    const handler = handlers[cmd as CommandName] as unknown as (a: unknown) => unknown;
    return handler(args);
  });

  const backend: MockBackend = {
    marker: MOCK_MARKER,
    scenario,
    lock,
    failNext: (code, message) => {
      state.failNext = { code, message: message ?? MESSAGES[code] ?? code };
    },
    setPromptDelay: (ms) => {
      state.promptMs = ms;
    },
    emit: ipcMock.emit,
    uninstall: () => {
      clearTimeout(idleTimer);
      pendingPrompt?.cancel();
      ipcMock.uninstall();
    },
  };
  if (state.phase === "unlocked") touch();
  return backend;
}

/** A short stand-in list. The real generator (Rust) uses the EFF long wordlist. */
const WORDS = [
  "acorn", "amber", "anchor", "apron", "arcade", "atlas", "autumn", "badge", "bamboo", "banjo",
  "barley", "basket", "beacon", "birch", "blossom", "bonfire", "boulder", "bramble", "breeze", "bridge",
  "bucket", "cabin", "cactus", "canyon", "carpet", "cedar", "cellar", "chalk", "cherry", "chimney",
  "cinder", "citrus", "clover", "cobalt", "comet", "copper", "coral", "cotton", "crater", "cricket",
  "crystal", "cypress", "dahlia", "delta", "denim", "desert", "dolphin", "dragon", "drizzle", "dune",
  "eagle", "ember", "emerald", "falcon", "feather", "fennel", "fern", "festival", "fiddle", "fjord",
  "flannel", "fossil", "fountain", "fox", "galaxy", "garnet", "geyser", "ginger", "glacier", "granite",
  "grove", "harbor", "harvest", "hazel", "heron", "hickory", "horizon", "iceberg", "indigo", "island",
  "ivory", "jasmine", "jigsaw", "juniper", "kayak", "kettle", "kiwi", "lagoon", "lantern", "lavender",
  "lemon", "lilac", "linen", "lotus", "magnet", "mango", "maple", "marble", "meadow", "meteor",
  "mint", "mosaic", "moss", "nectar", "nutmeg", "oasis", "ocean", "olive", "onyx", "orchid",
  "otter", "paddle", "papaya", "parade", "pebble", "pepper", "pigeon", "pine", "planet", "plum",
  "pocket", "pond", "poppy", "prairie", "pumpkin", "quartz", "quill", "rainbow", "raven", "reef",
  "ribbon", "river", "robin", "rocket", "saddle", "saffron", "sage", "sapphire", "satin", "sequoia",
  "shadow", "shell", "sierra", "silver", "sorrel", "spruce", "summit", "sunset", "tangent", "teapot",
  "thistle", "thunder", "tiger", "timber", "topaz", "tulip", "tundra", "tunnel", "turtle", "umber",
  "valley", "velvet", "violet", "voyage", "walnut", "willow", "window", "winter", "yarrow", "zephyr",
];
