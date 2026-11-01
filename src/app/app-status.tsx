/**
 * App status: the single source of truth for which screen shows (docs/IPC.md AppStatus).
 *
 * - `status` is null only while the first `app_status` is in flight (phase "loading").
 * - Commands that return an AppStatus (setup_*, unlock) hand it to `setStatus`.
 * - Anything that changes keys or the phase calls `refreshStatus()` afterwards.
 * - On the `locked` event every phase screen unmounts at once (all UI state is dropped),
 *   then the status is fetched again. Rust also reloads the webview.
 */
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { clearToasts } from "@/components/ui/use-toast";
import { type IpcError, ipc, toIpcError } from "@/lib/ipc";
import type { AppPhase, AppStatus } from "@/lib/ipc-types";
import { useIpcEvent } from "@/lib/use-ipc-event";

import { toastError } from "./toast-error";

export type Phase = AppPhase | "loading";

export interface AppStatusValue {
  status: AppStatus | null;
  phase: Phase;
  /** Why the last `app_status` failed (shown on the startup error screen). */
  error: IpcError | null;
  /** Fetches `app_status` again. Resolves with it, or null on failure. */
  refreshStatus: () => Promise<AppStatus | null>;
  /** Applies an AppStatus a command returned (setup_start/finish/cancel, unlock). */
  setStatus: (status: AppStatus) => void;
  /** Locks the vault (Ctrl+L). Errors become a toast. */
  lock: () => Promise<void>;
}

const AppStatusContext = createContext<AppStatusValue | null>(null);

export function AppStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatusState] = useState<AppStatus | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  // Bumped by every status change so a slow, older app_status reply never wins.
  const generation = useRef(0);

  const refreshStatus = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    return ipc.appStatus().then(
      (next) => {
        if (mine === generation.current) {
          setStatusState(next);
          setError(null);
        }
        return next;
      },
      (err: unknown) => {
        if (mine === generation.current) setError(toIpcError(err));
        return null;
      },
    );
  }, []);

  const setStatus = useCallback((next: AppStatus) => {
    generation.current += 1;
    setStatusState(next);
    setError(null);
  }, []);

  const lock = useCallback(async () => {
    try {
      await ipc.lock();
    } catch (err: unknown) {
      toastError(err, "Couldn't lock the vault");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useIpcEvent("locked", () => {
    // Drop every screen (and with it all decrypted data in JS) before anything else.
    generation.current += 1;
    setStatusState(null);
    clearToasts();
    void refreshStatus();
  });

  const value = useMemo<AppStatusValue>(
    () => ({ status, phase: status?.phase ?? "loading", error, refreshStatus, setStatus, lock }),
    [status, error, refreshStatus, setStatus, lock],
  );
  return <AppStatusContext value={value}>{children}</AppStatusContext>;
}

export function useAppStatus(): AppStatusValue {
  const value = use(AppStatusContext);
  if (value === null) throw new Error("useAppStatus must be used inside <AppStatusProvider>");
  return value;
}

/** The loaded status, for phase screens (they only render once it exists). */
export function useStatus(): AppStatus {
  const { status } = useAppStatus();
  if (status === null) throw new Error("useStatus is only available once app_status has loaded");
  return status;
}
