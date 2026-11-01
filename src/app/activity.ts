/**
 * Idle auto-lock lives in Rust (ARCHITECTURE §8.5). The UI tells it about user input
 * inside efre with throttled `activity` pings: at most one every 15 s.
 */
import { useEffect } from "react";

import { ipc } from "@/lib/ipc";

export const ACTIVITY_THROTTLE_MS = 15_000;

/** Input that counts as "the user is here". Scrolling via keyboard is covered by keydown. */
export const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"] as const;

/**
 * Returns a function to call on every input event; it calls `ping` on the leading edge,
 * then at most once per `intervalMs`. `now` must be monotonic (performance.now).
 */
export function createActivityThrottle(
  ping: () => void,
  now: () => number = () => performance.now(),
  intervalMs = ACTIVITY_THROTTLE_MS,
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t - last < intervalMs) return;
    last = t;
    ping();
  };
}

/** Pings Rust on user input while `enabled` (the vault is unlocked). */
export function useActivityPinger(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onInput = createActivityThrottle(() => {
      // A failed ping (e.g. already locked) needs no handling: the lock event follows.
      ipc.activity().catch(() => undefined);
    });
    const options: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onInput, options);
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onInput, options);
    };
  }, [enabled]);
}
