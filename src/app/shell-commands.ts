import { FolderOpen, Keyboard, Lock, Settings, WandSparkles } from "lucide-react";

import { ipc } from "@/lib/ipc";

import { useAppStatus } from "./app-status";
import { useRegisterCommands } from "./commands";
import { toastError } from "./toast-error";
import { useUIState } from "./ui-state";
import { useShortcut } from "./use-shortcut";

/**
 * App-level commands and shortcuts, active while unlocked: Ctrl+K palette, Ctrl+L lock,
 * "?" shortcut sheet. Feature shortcuts (Ctrl+N, Ctrl+F, Ctrl+C, Ctrl+B, Esc) belong to
 * the vault screen.
 */
export function useShellCommands(): void {
  const { lock } = useAppStatus();
  const ui = useUIState();
  const otherOverlayOpen = ui.overlayOpen && !ui.paletteOpen;

  useShortcut(
    "Ctrl+K",
    () => {
      ui.setPaletteOpen(!ui.paletteOpen);
    },
    { allowInInputs: true, enabled: !otherOverlayOpen },
  );
  useShortcut(
    "Ctrl+L",
    () => {
      void lock();
    },
    { allowInInputs: true },
  );
  useShortcut(
    "?",
    () => {
      ui.setShortcutsOpen(true);
    },
    { enabled: !ui.overlayOpen },
  );

  useRegisterCommands([
    {
      id: "app.lock",
      title: "Lock vault",
      group: "Vault",
      shortcut: "Ctrl+L",
      icon: Lock,
      keywords: ["close", "leave", "secure"],
      run: lock,
    },
    {
      id: "app.generator",
      title: "Generate a password",
      group: "Vault",
      icon: WandSparkles,
      keywords: ["passphrase", "random", "generator", "strong"],
      run: () => {
        ui.requestGenerator();
      },
    },
    {
      id: "app.open-vault-folder",
      title: "Open vault folder",
      group: "Vault",
      icon: FolderOpen,
      keywords: ["backup", "copy", "file", "explorer"],
      run: async () => {
        try {
          await ipc.openVaultFolder();
        } catch (err: unknown) {
          toastError(err, "Couldn't open the vault folder");
        }
      },
    },
    {
      id: "app.settings",
      title: "Open settings",
      group: "Settings",
      icon: Settings,
      keywords: ["preferences", "options"],
      run: () => {
        ui.openSettings();
      },
    },
    {
      id: "app.shortcuts",
      title: "Keyboard shortcuts",
      group: "Help",
      shortcut: "?",
      icon: Keyboard,
      keywords: ["keys", "help", "hotkeys"],
      run: () => {
        ui.setShortcutsOpen(true);
      },
    },
  ]);
}
