/**
 * Keyboard shortcuts in Windows notation: "Ctrl+K", "Ctrl+Shift+P", "Esc", "?", "Delete".
 * Ctrl is Ctrl (never Meta). Pure functions; the React hook is `useShortcut` (src/app).
 */

export interface ParsedShortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Normalized key: lower-case character ("k", "?", "/") or KeyboardEvent.key name ("escape"). */
  key: string;
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  del: "delete",
  space: " ",
  spacebar: " ",
  plus: "+",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pgup: "pageup",
  pgdn: "pagedown",
};

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "Enter",
  delete: "Delete",
  backspace: "Backspace",
  tab: "Tab",
  " ": "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  pageup: "Page Up",
  pagedown: "Page Down",
  home: "Home",
  end: "End",
};

function normalizeKey(name: string): string {
  const lower = name.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/** Parses "Ctrl+Shift+K". Throws on an empty or malformed combo (a programming error). */
export function parseShortcut(combo: string): ParsedShortcut {
  // "Ctrl++" means Ctrl and the "+" key.
  const parts = combo.endsWith("++") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
  const result: ParsedShortcut = { ctrl: false, alt: false, shift: false, key: "" };
  for (const raw of parts) {
    const part = raw.trim().toLowerCase();
    if (part === "ctrl" || part === "control") result.ctrl = true;
    else if (part === "alt") result.alt = true;
    else if (part === "shift") result.shift = true;
    else if (part !== "" && result.key === "") result.key = normalizeKey(raw.trim());
    else throw new Error(`Invalid shortcut: "${combo}"`);
  }
  if (result.key === "") throw new Error(`Invalid shortcut: "${combo}"`);
  return result;
}

const isLetter = (key: string) => /^[a-z]$/.test(key);
const isDigit = (key: string) => /^[0-9]$/.test(key);
/** A single printable character that isn't a letter or digit, e.g. "?" or "/". */
const isSymbol = (key: string) => key.length === 1 && !isLetter(key) && !isDigit(key) && key !== " ";

export type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
> & { getModifierState?: (key: string) => boolean };

/** Does this keydown match the shortcut? */
export function matchesShortcut(event: ShortcutEvent, shortcut: ParsedShortcut): boolean {
  if (event.metaKey) return false;
  // AltGr reports Ctrl+Alt on Windows; it types characters, so it never counts as Ctrl/Alt.
  const altGraph = event.getModifierState?.("AltGraph") === true;
  const ctrl = event.ctrlKey && !altGraph;
  const alt = event.altKey && !altGraph;
  if (ctrl !== shortcut.ctrl || alt !== shortcut.alt) return false;

  const key = event.key.toLowerCase();
  if (isSymbol(shortcut.key)) {
    // "?" already implies whatever Shift state the user's layout needs.
    return key === shortcut.key && (shortcut.shift ? event.shiftKey : true);
  }
  if (event.shiftKey !== shortcut.shift) return false;
  if (key === shortcut.key) return true;
  // Non-Latin layouts: Ctrl+K should still work where the K key types "л".
  if (isLetter(shortcut.key) && !isLetter(key)) return event.code === `Key${shortcut.key.toUpperCase()}`;
  if (isDigit(shortcut.key) && !isDigit(key)) return event.code === `Digit${shortcut.key}`;
  return false;
}

/** The keys to display for a combo: "Ctrl+Shift+K" → ["Ctrl", "Shift", "K"]. */
export function shortcutKeys(combo: string): string[] {
  const parsed = parseShortcut(combo);
  const keys: string[] = [];
  if (parsed.ctrl) keys.push("Ctrl");
  if (parsed.alt) keys.push("Alt");
  if (parsed.shift) keys.push("Shift");
  keys.push(DISPLAY_NAMES[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key));
  return keys;
}

/** Screen-reader friendly text, e.g. "Ctrl+K" (for aria-keyshortcuts use `ariaKeyShortcuts`). */
export function formatShortcut(combo: string): string {
  return shortcutKeys(combo).join("+");
}

/** Value for the aria-keyshortcuts attribute ("Control+K"). */
export function ariaKeyShortcuts(combo: string): string {
  const parsed = parseShortcut(combo);
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Control");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  const named: Readonly<Record<string, string>> = {
    escape: "Escape",
    enter: "Enter",
    delete: "Delete",
    " ": "Space",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  parts.push(named[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key));
  return parts.join("+");
}

/** True when the keystroke would type into a text control, so plain-key shortcuts must not fire. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes(
      target.type,
    );
  }
  return false;
}
