import { useCallback, useSyncExternalStore } from "react";

function mediaList(query: string): MediaQueryList | null {
  // Missing in some test environments (jsdom): then nothing matches.
  return typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** True while the CSS media query matches (false where matchMedia is missing). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaList(query);
      list?.addEventListener("change", onChange);
      return () => {
        list?.removeEventListener("change", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => mediaList(query)?.matches ?? false,
    () => false,
  );
}
