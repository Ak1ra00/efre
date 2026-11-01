import { useEffect, useEffectEvent, useMemo } from "react";

import { isEditableTarget, matchesShortcut, parseShortcut } from "@/lib/shortcut";

export interface ShortcutOptions {
  /** Default true. */
  enabled?: boolean;
  /**
   * Fire while focus is in a text field. Default false, so typing "?" or Ctrl+C in a
   * field keeps its normal meaning. The shell's Ctrl+K and Ctrl+L set it.
   */
  allowInInputs?: boolean;
  /** Call preventDefault() when the shortcut fires. Default true. */
  preventDefault?: boolean;
  /** Fire again while the key is held down. Default false. */
  allowRepeat?: boolean;
}

/**
 * Binds a global keyboard shortcut (Windows notation) while mounted:
 *
 *   useShortcut("Ctrl+N", newItem);
 *   useShortcut(["Delete", "Ctrl+D"], trashSelected, { enabled: selected !== null });
 *
 * Skips events another handler already handled (defaultPrevented, e.g. Esc closing a
 * dialog) and keystrokes that are part of an IME composition.
 */
export function useShortcut(
  combo: string | readonly string[],
  handler: (event: KeyboardEvent) => void,
  options: ShortcutOptions = {},
): void {
  const { enabled = true, allowInInputs = false, preventDefault = true, allowRepeat = false } = options;
  const key = typeof combo === "string" ? combo : combo.join("\n");
  const parsed = useMemo(() => key.split("\n").map(parseShortcut), [key]);
  const onShortcut = useEffectEvent(handler);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.repeat && !allowRepeat) return;
      if (!allowInInputs && isEditableTarget(event.target)) return;
      if (!parsed.some((shortcut) => matchesShortcut(event, shortcut))) return;
      if (preventDefault) event.preventDefault();
      onShortcut(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, allowInInputs, preventDefault, allowRepeat, parsed]);
}
