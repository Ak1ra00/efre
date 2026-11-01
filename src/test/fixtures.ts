/** Test data builders for IPC DTOs. Override only what a test cares about. */
import type { AppStatus, FieldView, ItemMeta, ItemView, KeyInfo } from "@/lib/ipc-types";

let seq = 0;
const hexId = () => {
  seq += 1;
  return seq.toString(16).padStart(32, "0");
};

export function makeKey(overrides: Partial<KeyInfo> = {}): KeyInfo {
  return {
    id: hexId(),
    nickname: "YubiKey 5C NFC",
    enrolledAt: 1_760_000_000,
    aaguid: "a25342c0-3cdc-4414-8e46-f4807fca511c",
    ...overrides,
  };
}

export function makeStatus(overrides: Partial<AppStatus> = {}): AppStatus {
  const phase = overrides.phase ?? "locked";
  const keys = overrides.keys ?? (phase === "setup" ? [] : [makeKey(), makeKey({ nickname: "Backup key" })]);
  return {
    phase,
    apiVersion: 9,
    unsupportedReason: phase === "unsupported" ? "Windows is too old." : null,
    keys,
    setupKeys: [],
    singleKeyWarning: phase !== "setup" && keys.length === 1,
    lastLockReason: null,
    vaultPath: "C:\\Users\\test\\AppData\\Local\\efre\\vault.efre",
    ...overrides,
  };
}

export function makeItemMeta(overrides: Partial<ItemMeta> = {}): ItemMeta {
  return {
    id: hexId(),
    kind: "login",
    title: "GitHub",
    username: "octocat",
    tags: [],
    favorite: false,
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_000,
    trashedAt: null,
    hasPassword: true,
    ...overrides,
  };
}

export function makeItemView(meta: Partial<ItemMeta> = {}, fields?: FieldView[]): ItemView {
  const m = makeItemMeta(meta);
  return {
    meta: m,
    fields: fields ?? [
      { id: 1, label: "Username", kind: "text", role: "username", value: m.username },
      { id: 2, label: "Password", kind: "hidden", role: "password", value: null },
      { id: 3, label: "Website", kind: "url", role: "url", value: "https://github.com" },
    ],
  };
}
