/** UI defaults from docs/IPC.md ("Defaults the UI uses"). */
import type { PassphraseOptions, PasswordOptions, Settings } from "./ipc-types";

export const DEFAULT_PASSWORD_OPTIONS: Readonly<PasswordOptions> = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
};

export const DEFAULT_PASSPHRASE_OPTIONS: Readonly<PassphraseOptions> = {
  words: 6,
  separator: "-",
  capitalize: false,
  includeNumber: false,
};

export const PASSWORD_LENGTH = { min: 8, max: 128 } as const;
export const PASSPHRASE_WORDS = { min: 3, max: 12 } as const;
export const PASSPHRASE_SEPARATOR_MAX = 3;

export const DEFAULT_SETTINGS: Readonly<Settings> = { autoLockMinutes: 5, clipboardClearSeconds: 30 };
export const AUTO_LOCK_MINUTES = { min: 1, max: 120 } as const;
export const CLIPBOARD_SECONDS = { min: 5, max: 300 } as const;
export const AUTO_LOCK_PRESETS = [1, 2, 5, 10, 15, 30, 60, 120] as const;
export const CLIPBOARD_PRESETS = [10, 20, 30, 45, 60, 90, 120] as const;

/** Revealed secrets hide again after this long (SPEC §5). */
export const REVEAL_SECONDS = 10;

export type Strength = "Weak" | "Fair" | "Strong" | "Very strong";

/** Strength label from `entropyBits`: < 50 Weak, < 70 Fair, < 100 Strong, else Very strong. */
export function strengthLabel(entropyBits: number): Strength {
  if (entropyBits < 50) return "Weak";
  if (entropyBits < 70) return "Fair";
  if (entropyBits < 100) return "Strong";
  return "Very strong";
}

/** "5 minutes", "1 minute", "2 hours". */
export function formatMinutes(minutes: number): string {
  if (minutes % 60 === 0 && minutes >= 60) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${String(hours)} hours`;
  }
  return minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
}

/** "30 seconds", "1 second". */
export function formatSeconds(seconds: number): string {
  return seconds === 1 ? "1 second" : `${String(seconds)} seconds`;
}
