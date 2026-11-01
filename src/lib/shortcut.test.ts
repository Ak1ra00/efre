import { describe, expect, it } from "vitest";

import { ariaKeyShortcuts, formatShortcut, matchesShortcut, parseShortcut, shortcutKeys, type ShortcutEvent } from "./shortcut";

const ev = (key: string, mods: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  key,
  code: "",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("parseShortcut", () => {
  it("parses Windows notation", () => {
    expect(parseShortcut("Ctrl+K")).toEqual({ ctrl: true, alt: false, shift: false, key: "k" });
    expect(parseShortcut("Ctrl+Shift+P")).toEqual({ ctrl: true, alt: false, shift: true, key: "p" });
    expect(parseShortcut("Esc").key).toBe("escape");
    expect(parseShortcut("?").key).toBe("?");
    expect(parseShortcut("Ctrl++").key).toBe("+");
  });

  it("rejects malformed combos", () => {
    expect(() => parseShortcut("")).toThrow();
    expect(() => parseShortcut("Ctrl+")).toThrow();
    expect(() => parseShortcut("K+L")).toThrow();
  });
});

describe("matchesShortcut", () => {
  const ctrlK = parseShortcut("Ctrl+K");

  it("requires exactly the listed modifiers", () => {
    expect(matchesShortcut(ev("k", { ctrlKey: true }), ctrlK)).toBe(true);
    expect(matchesShortcut(ev("K", { ctrlKey: true }), ctrlK)).toBe(true);
    expect(matchesShortcut(ev("k"), ctrlK)).toBe(false);
    expect(matchesShortcut(ev("k", { ctrlKey: true, shiftKey: true }), ctrlK)).toBe(false);
    expect(matchesShortcut(ev("k", { ctrlKey: true, altKey: true }), ctrlK)).toBe(false);
    // Meta (the Windows key) is never Ctrl.
    expect(matchesShortcut(ev("k", { metaKey: true }), ctrlK)).toBe(false);
  });

  it("matches the physical key on non-Latin layouts", () => {
    expect(matchesShortcut(ev("л", { ctrlKey: true, code: "KeyK" }), ctrlK)).toBe(true);
    expect(matchesShortcut(ev("л", { ctrlKey: true, code: "KeyL" }), ctrlK)).toBe(false);
  });

  it("treats '?' as a character, whatever Shift the layout needs", () => {
    const help = parseShortcut("?");
    expect(matchesShortcut(ev("?", { shiftKey: true }), help)).toBe(true);
    expect(matchesShortcut(ev("?"), help)).toBe(true);
    expect(matchesShortcut(ev("/", { shiftKey: false }), help)).toBe(false);
    expect(matchesShortcut(ev("?", { ctrlKey: true }), help)).toBe(false);
  });

  it("ignores AltGr (Ctrl+Alt on Windows) for typed characters", () => {
    const at = parseShortcut("?");
    const altGr = ev("?", { ctrlKey: true, altKey: true, getModifierState: (k) => k === "AltGraph" });
    expect(matchesShortcut(altGr, at)).toBe(true);
    expect(matchesShortcut(altGr, parseShortcut("Ctrl+Alt+?"))).toBe(false);
  });

  it("matches named keys", () => {
    expect(matchesShortcut(ev("Escape"), parseShortcut("Esc"))).toBe(true);
    expect(matchesShortcut(ev("Delete"), parseShortcut("Delete"))).toBe(true);
    expect(matchesShortcut(ev("Enter", { ctrlKey: true }), parseShortcut("Ctrl+Enter"))).toBe(true);
  });
});

describe("display", () => {
  it("formats keys for key caps, text and aria-keyshortcuts", () => {
    expect(shortcutKeys("Ctrl+Shift+K")).toEqual(["Ctrl", "Shift", "K"]);
    expect(shortcutKeys("Esc")).toEqual(["Esc"]);
    expect(formatShortcut("ctrl+l")).toBe("Ctrl+L");
    expect(ariaKeyShortcuts("Ctrl+K")).toBe("Control+K");
    expect(ariaKeyShortcuts("Esc")).toBe("Escape");
  });
});
