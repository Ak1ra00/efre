import { useEffect, useEffectEvent } from "react";

import { listenEvent, type UnlistenFn } from "./ipc";
import type { EventName, IpcEvents } from "./ipc-types";

/**
 * Subscribes to a Rust → webview event while mounted (and `enabled`).
 * The handler always sees the latest props/state; no need to memoize it.
 *
 * `useIpcEvent("key-step", (step) => setStep(step))`
 */
export function useIpcEvent<E extends EventName>(
  event: E,
  handler: (payload: IpcEvents[E]) => void,
  enabled = true,
): void {
  const onEvent = useEffectEvent(handler);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    listenEvent(event, (payload) => {
      if (!disposed) onEvent(payload);
    }).then(
      (fn) => {
        if (disposed) fn();
        else unlisten = fn;
      },
      (err: unknown) => {
        if (import.meta.env.DEV) console.warn(`efre: could not listen for "${event}"`, err);
      },
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event, enabled]);
}
