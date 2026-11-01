import { toastError } from "@/app/toast-error";
import { ipcErrorCode } from "@/lib/ipc";

/**
 * Reports a failed command as a toast. `locked` is the shell's business: the `locked`
 * event unmounts the vault (and clears toasts), so it is not shown here; `onLocked`
 * re-syncs the app status in case the event was missed.
 */
export function reportError(err: unknown, title?: string, onLocked?: () => void): void {
  if (ipcErrorCode(err) === "locked") {
    onLocked?.();
    return;
  }
  toastError(err, title);
}
