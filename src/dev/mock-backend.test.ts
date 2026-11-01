import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it } from "vitest";

import { ipc, isIpcError, listenEvent } from "@/lib/ipc";
import { COMMAND_NAMES, type KeyStep } from "@/lib/ipc-types";

import { installMockBackend, type MockBackend, scenarioFromUrl } from "./mock-backend";

let backend: MockBackend | undefined;
afterEach(() => {
  backend?.uninstall();
  backend = undefined;
});

const start = (phase: "setup" | "locked" | "unlocked", extra: Parameters<typeof installMockBackend>[0] = {}) => {
  backend = installMockBackend({ phase, promptMs: 0, ...extra });
  return backend;
};

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: unknown) => (isIpcError(e) ? e.code : "not an IpcError"),
  );

describe("dev mock backend", () => {
  it("implements every command in the contract", async () => {
    start("unlocked");
    // Unknown commands reject with Tauri's "Command … not found" string; arguments are
    // irrelevant here (bad ones may fail validation, which still proves the command exists).
    const unknown = await invoke("no_such_command").catch((e: unknown) => e);
    expect(unknown).toMatch(/not found/);
    for (const cmd of COMMAND_NAMES) {
      const outcome = await invoke(cmd, {}).then(
        () => "ok",
        (e: unknown) => e,
      );
      expect(typeof outcome === "string" && outcome.includes("not found"), cmd).toBe(false);
    }
  });

  it("runs the setup flow with two prompts per key and key-step events", async () => {
    start("setup");
    const steps: KeyStep[] = [];
    await listenEvent("key-step", (s) => steps.push(s));

    expect((await ipc.setupStart()).phase).toBe("setup");
    const key = await ipc.setupEnrollKey("Primary");
    expect(steps.map((s) => s.step)).toEqual(["createCredential", "confirmNewKey"]);
    expect((await ipc.appStatus()).setupKeys).toEqual([key]);

    const status = await ipc.setupFinish();
    expect(status).toMatchObject({ phase: "unlocked", singleKeyWarning: true });
    expect(await ipc.listItems()).toEqual([]);
  });

  it("unlocks, enforces the phase, and locks with an event", async () => {
    start("locked");
    expect(await codeOf(ipc.listItems())).toBe("locked");
    const reasons: string[] = [];
    await listenEvent("locked", (e) => reasons.push(e.reason));

    expect((await ipc.unlock()).phase).toBe("unlocked");
    expect((await ipc.listItems()).length).toBeGreaterThan(10);
    await ipc.lock();
    expect(reasons).toEqual(["manual"]);
    expect((await ipc.appStatus()).phase).toBe("locked");
  });

  it("withholds hidden values until revealed and keeps them on `keep`", async () => {
    start("unlocked");
    const github = (await ipc.listItems()).find((i) => i.title === "GitHub");
    if (github === undefined) throw new Error("sample item missing");
    const view = await ipc.getItem(github.id);
    const password = view.fields.find((f) => f.role === "password");
    expect(password?.value).toBeNull();
    const secret = await ipc.revealField(github.id, password?.id ?? 0);
    expect(secret.length).toBeGreaterThan(8);

    await ipc.updateItem(github.id, {
      kind: "login",
      title: "GitHub (work)",
      favorite: true,
      tags: ["dev"],
      fields: view.fields.map((f) => ({ id: f.id, label: f.label, kind: f.kind, role: f.role, value: "keep" as const })),
    });
    expect(await ipc.revealField(github.id, password?.id ?? 0)).toBe(secret);
    expect(await codeOf(ipc.copyRole(github.id, "password"))).toBe("resolved");
  });

  it("mirrors Rust's validation and trash rules", async () => {
    start("unlocked");
    const bad = { kind: "login" as const, title: "", favorite: false, tags: [], fields: [] };
    expect(await codeOf(ipc.createItem(bad))).toBe("invalid");
    const item = await ipc.createItem({ ...bad, title: "New" });
    expect(await codeOf(ipc.deleteItem(item.id))).toBe("vault.notInTrash");
    await ipc.trashItem(item.id);
    await ipc.deleteItem(item.id);
    expect(await codeOf(ipc.getItem(item.id))).toBe("notFound");
    expect(await codeOf(ipc.setSettings({ autoLockMinutes: 0, clipboardClearSeconds: 30 }))).toBe("invalid");
  });

  it("simulates failures, cancellation and key rotation prompts", async () => {
    const mock = start("unlocked", { promptMs: 50 });
    mock.failNext("authn.pinBlocked");
    expect(await codeOf(ipc.renameKey((await ipc.listKeys())[0]?.id ?? "", "Main"))).toBe("authn.pinBlocked");

    const pending = codeOf(ipc.addKey("Spare"));
    await ipc.cancelPrompt();
    expect(await pending).toBe("authn.cancelled");

    mock.setPromptDelay(0);
    const steps: KeyStep[] = [];
    await listenEvent("key-step", (s) => steps.push(s));
    const [first] = await ipc.listKeys();
    const remaining = await ipc.removeKey(first?.id ?? "");
    expect(remaining).toHaveLength(1);
    expect(steps).toEqual([{ step: "useKey", nickname: remaining[0]?.nickname }]);
    expect(await codeOf(ipc.removeKey(remaining[0]?.id ?? ""))).toBe("vault.lastKey");
  });

  it("generates within the IPC limits", async () => {
    start("unlocked");
    const password = await ipc.generatePassword({
      length: 24,
      lowercase: true,
      uppercase: false,
      digits: true,
      symbols: false,
      avoidAmbiguous: true,
    });
    expect(password.value).toMatch(/^[a-z0-9]{24}$/);
    expect(password.value).not.toMatch(/[lo01]/);
    const phrase = await ipc.generatePassphrase({ words: 5, separator: "-", capitalize: true, includeNumber: false });
    expect(phrase.value.split("-")).toHaveLength(5);
    expect(phrase.entropyBits).toBeCloseTo(5 * Math.log2(7776));
    expect(await codeOf(ipc.copyGenerated())).toBe("resolved");
    const tooShort = { length: 4, lowercase: true, uppercase: true, digits: true, symbols: true, avoidAmbiguous: false };
    expect(await codeOf(ipc.generatePassword(tooShort))).toBe("invalid");
  });

  it("reads scenarios from the URL", () => {
    expect(scenarioFromUrl("?phase=unlocked&keys=1&empty=1&prompt=10&fail=authn.timeout&reason=idle")).toMatchObject({
      phase: "unlocked",
      keys: 1,
      empty: true,
      promptMs: 10,
      fail: "authn.timeout",
      lastLockReason: "idle",
    });
    expect(scenarioFromUrl("?phase=bogus&fail=nope")).toMatchObject({ phase: "locked", fail: null, keys: 2 });
  });
});
