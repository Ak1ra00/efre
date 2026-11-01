/**
 * UI state shared across features: which global overlay is open (settings, command
 * palette, shortcut sheet, generator). At most one is open at a time; opening one closes
 * the others. The state resets whenever the phase changes (the provider is keyed by it).
 */
import { createContext, type ReactNode, use, useMemo, useState } from "react";

/** Settings dialog sections (E3 renders them in this order). */
export type SettingsSection = "keys" | "timers" | "vault" | "security";
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["keys", "timers", "vault", "security"];

type Overlay = "settings" | "palette" | "shortcuts" | "generator";

export interface UIStateValue {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** Opens Settings at `section` (default: the last one shown, initially "keys"). */
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;

  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;

  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;

  generatorOpen: boolean;
  /** Set when the generator was requested with a callback: show a "Use" button that calls it. */
  generatorOnUse: ((value: string) => void) | null;
  /**
   * Opens the generator. With `onUse`, the dialog offers "Use" and hands the generated
   * value back (e.g. to fill a password field); without it, it only offers "Copy" (in Rust).
   */
  requestGenerator: (onUse?: (value: string) => void) => void;
  closeGenerator: () => void;

  /** True while any of the overlays above is open. */
  overlayOpen: boolean;
}

interface State {
  overlay: Overlay | null;
  section: SettingsSection;
  onUse: ((value: string) => void) | null;
}

type Actions = Pick<
  UIStateValue,
  | "openSettings"
  | "closeSettings"
  | "setSettingsSection"
  | "setPaletteOpen"
  | "setShortcutsOpen"
  | "requestGenerator"
  | "closeGenerator"
>;

function createActions(update: (fn: (state: State) => State) => void): Actions {
  const open = (overlay: Overlay) => {
    update((s) => ({ ...s, overlay }));
  };
  const close = (overlay: Overlay) => {
    update((s) => (s.overlay === overlay ? { ...s, overlay: null } : s));
  };
  return {
    openSettings: (section) => {
      update((s) => ({ ...s, overlay: "settings", section: section ?? s.section }));
    },
    closeSettings: () => {
      close("settings");
    },
    setSettingsSection: (section) => {
      update((s) => ({ ...s, section }));
    },
    setPaletteOpen: (isOpen) => {
      if (isOpen) open("palette");
      else close("palette");
    },
    setShortcutsOpen: (isOpen) => {
      if (isOpen) open("shortcuts");
      else close("shortcuts");
    },
    requestGenerator: (onUse) => {
      update((s) => ({ ...s, overlay: "generator", onUse: onUse ?? null }));
    },
    closeGenerator: () => {
      update((s) => (s.overlay === "generator" ? { ...s, overlay: null, onUse: null } : { ...s, onUse: null }));
    },
  };
}

const UIStateContext = createContext<UIStateValue | null>(null);

export function UIStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ overlay: null, section: "keys", onUse: null });
  // Stable for the provider's lifetime, so consumers can use them in effect deps.
  const [actions] = useState(() => createActions(setState));
  const value = useMemo<UIStateValue>(
    () => ({
      ...actions,
      settingsOpen: state.overlay === "settings",
      settingsSection: state.section,
      paletteOpen: state.overlay === "palette",
      shortcutsOpen: state.overlay === "shortcuts",
      generatorOpen: state.overlay === "generator",
      generatorOnUse: state.onUse,
      overlayOpen: state.overlay !== null,
    }),
    [actions, state],
  );
  return <UIStateContext value={value}>{children}</UIStateContext>;
}

export function useUIState(): UIStateValue {
  const value = use(UIStateContext);
  if (value === null) throw new Error("useUIState must be used inside <UIStateProvider>");
  return value;
}
