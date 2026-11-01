/**
 * Defence in depth against browser features a WebView2 still has: its context menu
 * (Print, Save as, Inspect) and the print / view-source / downloads accelerators. Rust
 * should also turn off WebView2's browser accelerator keys and default context menu;
 * these guards cover the gap. Printing is additionally blanked by `@media print`.
 *
 * Features must not bind the blocked combos below.
 */
import { useEffect } from "react";

import { isEditableTarget, matchesShortcut, parseShortcut } from "@/lib/shortcut";

export const BLOCKED_BROWSER_SHORTCUTS = ["Ctrl+P", "Ctrl+Shift+P", "Ctrl+U", "Ctrl+J"] as const;
const BLOCKED = BLOCKED_BROWSER_SHORTCUTS.map(parseShortcut);

export function useBrowserGuards(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (BLOCKED.some((shortcut) => matchesShortcut(event, shortcut))) event.preventDefault();
    };
    // Text fields keep their native menu (cut, copy, paste).
    const onContextMenu = (event: MouseEvent) => {
      if (!isEditableTarget(event.target)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    // Dev builds keep the menu so "Inspect" works.
    if (!import.meta.env.DEV) window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);
}
