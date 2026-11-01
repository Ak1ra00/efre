/**
 * UI state shared across features: which global overlay is open (settings, command
 * palette, shortcut sheet, generator). At most one is open at a time; opening one closes
 * the others. The state resets whenever the phase changes (the provider is keyed by it).
 */
import { createContext, type ReactNode, use, useCallback, useMemo, useState } from "react";

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

const UIStateContext = createContext<UIStateValue | null>(null);

export function UIStateProvider({ children }: { children: ReactNode }) {
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("keys");
  // Wrapped in an object: a bare function passed to setState would be called as an updater.
  const [generatorRequest, setGeneratorRequest] = useState<{ onUse: ((value: string) => void) | null }>({
    onUse: null,
  });

  const close = useCallback((which: Overlay) => {
    setOverlay((current) => (current === which ? null : current));
  }, []);

  const openSettings = useCallback((section?: SettingsSection) => {
    if (section !== undefined) setSettingsSection(section);
    setOverlay("settings");
  }, []);
  const closeSettings = useCallback(() => {
    close("settings");
  }, [close]);
  const setPaletteOpen = useCallback(
    (open: boolean) => {
      if (open) setOverlay("palette");
      else close("palette");
    },
    [close],
  );
  const setShortcutsOpen = useCallback(
    (open: boolean) => {
      if (open) setOverlay("shortcuts");
      else close("shortcuts");
    },
    [close],
  );
  const requestGenerator = useCallback((onUse?: (value: string) => void) => {
    setGeneratorRequest({ onUse: onUse ?? null });
    setOverlay("generator");
  }, []);
  const closeGenerator = useCallback(() => {
    close("generator");
    setGeneratorRequest({ onUse: null });
  }, [close]);

  const value = useMemo<UIStateValue>(
    () => ({
      settingsOpen: overlay === "settings",
      settingsSection,
      openSettings,
      closeSettings,
      setSettingsSection,
      paletteOpen: overlay === "palette",
      setPaletteOpen,
      shortcutsOpen: overlay === "shortcuts",
      setShortcutsOpen,
      generatorOpen: overlay === "generator",
      generatorOnUse: generatorRequest.onUse,
      requestGenerator,
      closeGenerator,
      overlayOpen: overlay !== null,
    }),
    [
      overlay,
      settingsSection,
      openSettings,
      closeSettings,
      setPaletteOpen,
      setShortcutsOpen,
      generatorRequest,
      requestGenerator,
      closeGenerator,
    ],
  );
  return <UIStateContext value={value}>{children}</UIStateContext>;
}

export function useUIState(): UIStateValue {
  const value = use(UIStateContext);
  if (value === null) throw new Error("useUIState must be used inside <UIStateProvider>");
  return value;
}
