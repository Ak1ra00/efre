import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect } from "react";
import { describe, expect, it } from "vitest";

import { AppStatusProvider, useAppStatus } from "@/app/app-status";
import { type SettingsSection, UIStateProvider, useUIState } from "@/app/ui-state";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { KeyInfo, SecurityInfo } from "@/lib/ipc-types";
import { makeKey, makeStatus } from "@/test/fixtures";
import { mockIpc } from "@/test/ipc-mock";

import { SettingsDialog } from "./SettingsDialog";

const primary = makeKey({ nickname: "Primary" });
const backup = makeKey({ nickname: "Backup" });

function WhenLoaded({ children }: { children: ReactNode }) {
  return useAppStatus().status === null ? null : children;
}

function OpenAt({ section }: { section: SettingsSection }) {
  const { openSettings } = useUIState();
  useEffect(() => {
    openSettings(section);
  }, [openSettings, section]);
  return null;
}

function renderSettings(section: SettingsSection = "keys") {
  return render(
    <TooltipProvider>
      <AppStatusProvider>
        <WhenLoaded>
          <UIStateProvider>
            <OpenAt section={section} />
            <SettingsDialog />
          </UIStateProvider>
        </WhenLoaded>
      </AppStatusProvider>
      <Toaster />
    </TooltipProvider>,
  );
}

function unlocked(keys: KeyInfo[] = [primary, backup]) {
  return mockIpc()
    .on("app_status", makeStatus({ phase: "unlocked", keys, singleKeyWarning: keys.length === 1 }))
    .on("list_keys", keys);
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("SettingsDialog", () => {
  it("opens at the requested section", async () => {
    unlocked().on("get_settings", { autoLockMinutes: 5, clipboardClearSeconds: 30 });
    renderSettings("timers");
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Auto-lock & clipboard" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "Auto-lock & clipboard" })).toBeInTheDocument();
  });

  describe("YubiKeys", () => {
    it("lists the keys with their enrolled dates", async () => {
      unlocked();
      renderSettings();
      const list = await screen.findByRole("list", { name: "Enrolled keys" });
      expect(within(list).getByText("Primary")).toBeInTheDocument();
      expect(within(list).getByText("Backup")).toBeInTheDocument();
      expect(within(list).getAllByText(/^Enrolled /)).toHaveLength(2);
    });

    it("adds a key through three prompts, saying which key each one is for", async () => {
      const user = userEvent.setup();
      const added = makeKey({ nickname: "Spare" });
      const addKey = deferred<KeyInfo>();
      const ipc = unlocked().on("add_key", () => addKey.promise);
      renderSettings();
      await screen.findByRole("list", { name: "Enrolled keys" });

      await user.click(screen.getByRole("button", { name: "Add key" }));
      const nickname = screen.getByRole("textbox", { name: "Nickname" });
      expect(nickname).toHaveValue("Key 3");
      expect(screen.getByText(/One USB port is enough/)).toBeInTheDocument();
      await user.clear(nickname);
      await user.type(nickname, "Spare");
      await user.click(screen.getByRole("button", { name: "Add key" }));
      expect(ipc.callsTo("add_key")).toEqual([{ nickname: "Spare" }]);

      const overlay = await screen.findByRole("dialog", { name: "Waiting for Windows Security…" });
      const steps = within(overlay).getByRole("list", { name: "Progress" });
      expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
        expect.stringContaining("Confirm with an enrolled key"),
        expect.stringContaining("Register the new key"),
        expect.stringContaining("Confirm with the new key"),
      ]);

      await ipc.emit("key-step", { step: "useEnrolledKey", nickname: null });
      expect(await within(overlay).findByText("Confirm with your YubiKey")).toBeInTheDocument();
      expect(overlay).toHaveTextContent("Step 1 of 3");
      expect(overlay).toHaveTextContent("Use Primary or Backup.");

      await ipc.emit("key-step", { step: "createCredential", nickname: null });
      expect(await within(overlay).findByText("Insert the new YubiKey")).toBeInTheDocument();
      expect(overlay).toHaveTextContent("Step 2 of 3");

      await ipc.emit("key-step", { step: "confirmNewKey", nickname: null });
      expect(await within(overlay).findByText("Touch the new key again")).toBeInTheDocument();
      expect(overlay).toHaveTextContent("Step 3 of 3");
      expect(within(steps).getByText("Confirm with the new key").closest("li")).toHaveAttribute("aria-current", "step");

      ipc.on("list_keys", [primary, backup, added]);
      addKey.resolve(added);
      expect(await screen.findByText("“Spare” added")).toBeInTheDocument();
      const list = await screen.findByRole("list", { name: "Enrolled keys" });
      expect(within(list).getByText("Spare")).toBeInTheDocument();
      // The status (and with it the single-key banner) is refreshed.
      expect(ipc.callsTo("app_status").length).toBeGreaterThanOrEqual(2);
    });

    it("shows why adding failed", async () => {
      const user = userEvent.setup();
      unlocked().failOnce("add_key", "authn.alreadyEnrolled");
      renderSettings();
      await screen.findByRole("list", { name: "Enrolled keys" });
      await user.click(screen.getByRole("button", { name: "Add key" }));
      await user.click(screen.getByRole("button", { name: "Add key" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("This key is already enrolled");
    });

    it("renames a key with one prompt", async () => {
      const user = userEvent.setup();
      const ipc = unlocked().on("rename_key", ({ id, nickname }) => ({ ...backup, id, nickname }));
      renderSettings();
      await user.click(await screen.findByRole("button", { name: "Rename Backup" }));
      const field = screen.getByRole("textbox", { name: "New name for “Backup”" });
      await user.clear(field);
      await user.type(field, "  Fire safe  {Enter}");
      await waitFor(() => {
        expect(ipc.callsTo("rename_key")).toEqual([{ id: backup.id, nickname: "Fire safe" }]);
      });
      expect(await screen.findByText("Key renamed")).toBeInTheDocument();
    });

    it("removes a lost key only after a confirmation, with progress per remaining key", async () => {
      const user = userEvent.setup();
      const removal = deferred<KeyInfo[]>();
      const ipc = unlocked().on("remove_key", () => removal.promise);
      renderSettings();

      await user.click(await screen.findByRole("button", { name: "Remove Backup" }));
      const confirm = await screen.findByRole("alertdialog", { name: "Remove “Backup”?" });
      expect(confirm).toHaveTextContent("re-encrypts your whole vault with a new key");
      expect(confirm).toHaveTextContent("Every remaining key confirms once: Primary");
      expect(confirm).toHaveTextContent(
        "Copies of vault.efre made before now can still be opened with “Backup”. Delete them, then make a fresh copy.",
      );
      expect(ipc.callsTo("remove_key")).toHaveLength(0);

      await user.click(within(confirm).getByRole("button", { name: "Remove key" }));
      expect(ipc.callsTo("remove_key")).toEqual([{ id: backup.id }]);

      const overlay = await screen.findByRole("dialog", { name: "Waiting for Windows Security…" });
      await ipc.emit("key-step", { step: "useKey", nickname: "Primary" });
      expect(await within(overlay).findByText("Use “Primary”")).toBeInTheDocument();
      const progress = within(overlay).getByRole("list", { name: "Progress" });
      expect(within(progress).getByText("Primary").closest("li")).toHaveAttribute("aria-current", "step");

      ipc.on("list_keys", [primary]);
      removal.resolve([primary]);
      expect(await screen.findByText("“Backup” removed")).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Remove Backup" })).not.toBeInTheDocument();
      });
    });

    it("does nothing when the removal is cancelled in the confirmation", async () => {
      const user = userEvent.setup();
      const ipc = unlocked();
      renderSettings();
      await user.click(await screen.findByRole("button", { name: "Remove Primary" }));
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      });
      expect(ipc.callsTo("remove_key")).toHaveLength(0);
    });

    it("can't remove the only key, and says to add a backup first", async () => {
      const user = userEvent.setup();
      unlocked([primary]);
      renderSettings();
      const remove = await screen.findByRole("button", { name: "Remove Primary" });
      expect(remove).toBeDisabled();
      expect(remove).toHaveAccessibleDescription(/add a backup first/);
      expect(screen.getByText("Only one key can open this vault")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Add backup key" }));
      expect(screen.getByRole("textbox", { name: "Nickname" })).toHaveValue("Backup");
    });

    it("Esc cancels an inline edit without closing Settings", async () => {
      const user = userEvent.setup();
      unlocked();
      renderSettings();
      await user.click(await screen.findByRole("button", { name: "Rename Primary" }));
      expect(screen.getByRole("textbox", { name: "New name for “Primary”" })).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("textbox", { name: "New name for “Primary”" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    });
  });

  describe("timers", () => {
    it("saves a new auto-lock time with set_settings", async () => {
      const user = userEvent.setup();
      const ipc = unlocked()
        .on("get_settings", { autoLockMinutes: 5, clipboardClearSeconds: 30 })
        .on("set_settings", ({ settings }) => settings);
      renderSettings("timers");

      const autoLock = await screen.findByRole("combobox", { name: "Lock after inactivity" });
      expect(autoLock).toHaveTextContent("5 minutes");
      await user.click(autoLock);
      await user.click(await screen.findByRole("option", { name: "10 minutes" }));

      await waitFor(() => {
        expect(ipc.callsTo("set_settings")).toEqual([{ settings: { autoLockMinutes: 10, clipboardClearSeconds: 30 } }]);
      });
      expect(await screen.findByText("Saved")).toBeInTheDocument();
      expect(autoLock).toHaveTextContent("10 minutes");
    });

    it("saves a new clipboard time and offers the IPC.md presets", async () => {
      const user = userEvent.setup();
      const ipc = unlocked()
        .on("get_settings", { autoLockMinutes: 5, clipboardClearSeconds: 30 })
        .on("set_settings", ({ settings }) => settings);
      renderSettings("timers");

      await user.click(await screen.findByRole("combobox", { name: "Clear the clipboard after" }));
      expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
        "10 seconds",
        "20 seconds",
        "30 seconds",
        "45 seconds",
        "1 minute",
        "90 seconds",
        "2 minutes",
      ]);
      await user.click(screen.getByRole("option", { name: "45 seconds" }));
      await waitFor(() => {
        expect(ipc.callsTo("set_settings")).toEqual([{ settings: { autoLockMinutes: 5, clipboardClearSeconds: 45 } }]);
      });
    });

    it("puts the old value back when saving fails", async () => {
      const user = userEvent.setup();
      unlocked().on("get_settings", { autoLockMinutes: 5, clipboardClearSeconds: 30 }).failOnce("set_settings", "internal");
      renderSettings("timers");
      const autoLock = await screen.findByRole("combobox", { name: "Lock after inactivity" });
      await user.click(autoLock);
      await user.click(await screen.findByRole("option", { name: "1 hour" }));
      expect(await screen.findByText("Couldn't save the setting")).toBeInTheDocument();
      expect(autoLock).toHaveTextContent("5 minutes");
    });
  });

  describe("vault file", () => {
    it("shows the path and opens the folder", async () => {
      const user = userEvent.setup();
      const ipc = unlocked().on("open_vault_folder", null);
      renderSettings("vault");
      expect(await screen.findByRole("textbox", { name: "Location" })).toHaveValue(
        "C:\\Users\\test\\AppData\\Local\\efre\\vault.efre",
      );
      expect(screen.getByText(/A removed key still opens copies/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Open vault folder" }));
      expect(ipc.callsTo("open_vault_folder")).toHaveLength(1);
    });
  });

  describe("security", () => {
    it("shows versions, protections and honest limits", async () => {
      const info: SecurityInfo = {
        appVersion: "0.1.0",
        formatVersion: 1,
        webauthnApiVersion: 9,
        vaultPath: "C:\\vault.efre",
        keyCount: 2,
        protections: ["Screen capture blocked"],
        limits: ["Restoring an older copy of the whole vault file can't be detected"],
      };
      unlocked().on("security_info", info);
      renderSettings("security");
      expect(await screen.findByText("Screen capture blocked")).toBeInTheDocument();
      expect(screen.getByText("Restoring an older copy of the whole vault file can't be detected")).toBeInTheDocument();
      expect(screen.getByText("0.1.0")).toBeInTheDocument();
      expect(screen.getByText("v9")).toBeInTheDocument();
    });

    it("offers a retry when security_info fails", async () => {
      const user = userEvent.setup();
      const ipc = unlocked().failOnce("security_info", "internal");
      ipc.on("security_info", {
        appVersion: "0.1.0",
        formatVersion: 1,
        webauthnApiVersion: null,
        vaultPath: "",
        keyCount: 2,
        protections: [],
        limits: [],
      });
      renderSettings("security");
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the security details");
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Not available")).toBeInTheDocument();
    });
  });
});
