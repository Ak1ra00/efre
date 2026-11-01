import { describe, expect, it, vi } from "vitest";

import { makeItemMeta, makeKey, makeStatus } from "@/test/fixtures";
import { mockIpc } from "@/test/ipc-mock";

import {
  describeKeyStep,
  friendlyError,
  IpcError,
  ipc,
  ipcErrorCode,
  isIpcError,
  listenEvent,
  onKeyStep,
  onLocked,
  toIpcError,
} from "./ipc";
import { COMMAND_NAMES, IPC_ERROR_CODES, type ItemDraft, type KeyStep } from "./ipc-types";

const draft: ItemDraft = {
  kind: "login",
  title: "GitHub",
  favorite: false,
  tags: ["dev"],
  fields: [{ id: null, label: "Password", kind: "hidden", role: "password", value: { set: "s3cret" } }],
};

describe("ipc wrappers", () => {
  it("call every command with its snake_case name and camelCase args", async () => {
    const mock = mockIpc();
    for (const cmd of COMMAND_NAMES) mock.on(cmd, () => null);

    const calls: [() => Promise<unknown>, string, Record<string, unknown>][] = [
      [() => ipc.appStatus(), "app_status", {}],
      [() => ipc.setupStart(), "setup_start", {}],
      [() => ipc.setupEnrollKey("Primary"), "setup_enroll_key", { nickname: "Primary" }],
      [() => ipc.setupFinish(), "setup_finish", {}],
      [() => ipc.setupCancel(), "setup_cancel", {}],
      [() => ipc.unlock(), "unlock", {}],
      [() => ipc.lock(), "lock", {}],
      [() => ipc.cancelPrompt(), "cancel_prompt", {}],
      [() => ipc.activity(), "activity", {}],
      [() => ipc.listItems(), "list_items", {}],
      [() => ipc.getItem("a1"), "get_item", { id: "a1" }],
      [() => ipc.createItem(draft), "create_item", { draft }],
      [() => ipc.updateItem("a1", draft), "update_item", { id: "a1", draft }],
      [() => ipc.setFavorite("a1", true), "set_favorite", { id: "a1", favorite: true }],
      [() => ipc.trashItem("a1"), "trash_item", { id: "a1" }],
      [() => ipc.restoreItem("a1"), "restore_item", { id: "a1" }],
      [() => ipc.deleteItem("a1"), "delete_item", { id: "a1" }],
      [() => ipc.emptyTrash(), "empty_trash", {}],
      [() => ipc.revealField("a1", 2), "reveal_field", { id: "a1", fieldId: 2 }],
      [() => ipc.copyField("a1", 2), "copy_field", { id: "a1", fieldId: 2 }],
      [() => ipc.copyRole("a1", "password"), "copy_role", { id: "a1", role: "password" }],
      [
        () => ipc.generatePassword({ length: 20, lowercase: true, uppercase: true, digits: true, symbols: true, avoidAmbiguous: false }),
        "generate_password",
        { options: { length: 20, lowercase: true, uppercase: true, digits: true, symbols: true, avoidAmbiguous: false } },
      ],
      [
        () => ipc.generatePassphrase({ words: 6, separator: "-", capitalize: false, includeNumber: false }),
        "generate_passphrase",
        { options: { words: 6, separator: "-", capitalize: false, includeNumber: false } },
      ],
      [() => ipc.copyGenerated(), "copy_generated", {}],
      [() => ipc.getSettings(), "get_settings", {}],
      [
        () => ipc.setSettings({ autoLockMinutes: 10, clipboardClearSeconds: 45 }),
        "set_settings",
        { settings: { autoLockMinutes: 10, clipboardClearSeconds: 45 } },
      ],
      [() => ipc.listKeys(), "list_keys", {}],
      [() => ipc.addKey("Backup"), "add_key", { nickname: "Backup" }],
      [() => ipc.renameKey("k1", "Main"), "rename_key", { id: "k1", nickname: "Main" }],
      [() => ipc.removeKey("k1"), "remove_key", { id: "k1" }],
      [() => ipc.openVaultFolder(), "open_vault_folder", {}],
      [() => ipc.securityInfo(), "security_info", {}],
    ];

    for (const [run] of calls) await run();

    expect(mock.calls.map((c) => [c.cmd, c.args])).toEqual(calls.map(([, cmd, args]) => [cmd, args]));
    // The wrapper covers the whole contract.
    expect(new Set(mock.calls.map((c) => c.cmd))).toEqual(new Set(COMMAND_NAMES));
    expect(Object.keys(ipc)).toHaveLength(COMMAND_NAMES.length);
  });

  it("resolve with the typed result", async () => {
    const status = makeStatus({ phase: "unlocked" });
    const items = [makeItemMeta(), makeItemMeta({ title: "Bank" })];
    mockIpc().on("app_status", status).on("list_items", items).on("add_key", ({ nickname }) => makeKey({ nickname }));

    await expect(ipc.appStatus()).resolves.toEqual(status);
    await expect(ipc.listItems()).resolves.toEqual(items);
    await expect(ipc.addKey("Spare")).resolves.toMatchObject({ nickname: "Spare" });
  });

  it("reject with an IpcError carrying the stable code", async () => {
    mockIpc().failOnce("unlock", "authn.pinBlocked", "the security key's PIN is blocked");

    const err: unknown = await ipc.unlock().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect(isIpcError(err)).toBe(true);
    expect(ipcErrorCode(err)).toBe("authn.pinBlocked");
    expect((err as IpcError).message).toBe("the security key's PIN is blocked");
  });

  it("normalize Tauri's own string and Error rejections to `internal`", () => {
    expect(toIpcError("Command foo not found")).toMatchObject({ code: "internal", message: "Command foo not found" });
    expect(toIpcError(new TypeError("boom"))).toMatchObject({ code: "internal", message: "boom" });
    expect(toIpcError(42)).toMatchObject({ code: "internal" });
    expect(isIpcError({ code: "locked", message: "x" })).toBe(true);
    expect(isIpcError(new Error("x"))).toBe(false);
    expect(ipcErrorCode("nope")).toBeNull();
  });
});

describe("events", () => {
  it("deliver payloads and unsubscribe cleanly", async () => {
    const mock = mockIpc();
    const steps: KeyStep[] = [];
    const unlisten = await onKeyStep((s) => steps.push(s));
    const locked = vi.fn();
    const unlistenLocked = await onLocked(locked);

    await mock.emit("key-step", { step: "useKey", nickname: "Backup" });
    await mock.emit("locked", { reason: "idle" });
    expect(steps).toEqual([{ step: "useKey", nickname: "Backup" }]);
    expect(locked).toHaveBeenCalledWith({ reason: "idle" });

    unlisten();
    unlistenLocked();
    await vi.waitFor(() => {
      expect(mock.listenerCount("key-step")).toBe(0);
    });
    await mock.emit("key-step", { step: "useEnrolledKey", nickname: null });
    expect(steps).toHaveLength(1);
  });

  it("listenEvent is typed per event", async () => {
    const mock = mockIpc();
    const reasons: string[] = [];
    await listenEvent("locked", (e) => reasons.push(e.reason));
    await mock.emit("locked", { reason: "unplug" });
    expect(reasons).toEqual(["unplug"]);
  });
});

describe("friendlyError", () => {
  it("has specific copy for every error code", () => {
    const generic = friendlyError({ code: "something.new", message: "" });
    for (const code of IPC_ERROR_CODES) {
      const copy = friendlyError({ code, message: "" });
      expect(copy.code).toBe(code);
      expect(copy.title.length).toBeGreaterThan(3);
      expect(copy.description.length).toBeGreaterThan(10);
      if (code !== "internal") expect(copy.title).not.toBe(generic.title);
    }
  });

  it("covers the 'key not recognised' case under authn.cancelled", () => {
    const copy = friendlyError(new IpcError("authn.cancelled", "the operation was cancelled"));
    expect(copy.description).toMatch(/didn't recognise/);
    expect(copy.description).toMatch(/other key/);
  });

  it("uses Rust's message for `invalid` and the hex code for `authn.platform`", () => {
    expect(friendlyError({ code: "invalid", message: "title must be 1 to 256 characters" }).description).toBe(
      "Title must be 1 to 256 characters.",
    );
    expect(friendlyError({ code: "authn.platform", message: "Windows reported error 0x80090027" }).description).toContain(
      "0x80090027",
    );
  });

  it("falls back for unknown codes and plain JS errors", () => {
    expect(friendlyError({ code: "future.code", message: "something new" })).toEqual({
      code: "future.code",
      title: "Something went wrong",
      description: "Something new.",
    });
    expect(friendlyError(new Error("boom")).code).toBe("internal");
  });

  it("describes every key step", () => {
    expect(describeKeyStep({ step: "useEnrolledKey", nickname: null }).title).toMatch(/YubiKey/);
    expect(describeKeyStep({ step: "createCredential", nickname: null }).title).toMatch(/new/);
    expect(describeKeyStep({ step: "confirmNewKey", nickname: null }).title).toMatch(/again/);
    expect(describeKeyStep({ step: "useKey", nickname: "Backup" }).title).toContain("Backup");
  });
});
