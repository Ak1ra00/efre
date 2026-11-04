import { useShortcut } from "@/app/use-shortcut";

/**
 * Enter runs a screen's main action when nothing else would handle it: focus is on the
 * page or on a non-interactive element (e.g. a heading focused after a step change).
 * Enter on a focused button, link or field keeps its normal meaning.
 */
export function useEnterKey(action: () => void, enabled = true): void {
  useShortcut(
    "Enter",
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("button, a[href], input, select, textarea, [role='button'], [role='checkbox'], [role='switch'], [role='tab'], [role='option'], [role='slider'], [role='combobox']") !== null) {
        return;
      }
      if (target instanceof Element && target.closest("[role='dialog'], [role='alertdialog']") !== null) return;
      event.preventDefault();
      action();
    },
    { enabled, preventDefault: false },
  );
}
