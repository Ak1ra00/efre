import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * How much room the vault has (the window width; the vault fills the window):
 * - wide:   sidebar, list and detail side by side;
 * - medium: the sidebar shrinks to an icon rail (it can be expanded);
 * - narrow: icon rail plus one pane at a time (list, then detail with a back button).
 */
export type LayoutMode = "wide" | "medium" | "narrow";

export const WIDE_QUERY = "(min-width: 1100px)";
export const MEDIUM_QUERY = "(min-width: 720px)";

function currentMode(): LayoutMode {
  if (typeof window.matchMedia !== "function") return "wide";
  if (window.matchMedia(WIDE_QUERY).matches) return "wide";
  if (window.matchMedia(MEDIUM_QUERY).matches) return "medium";
  return "narrow";
}

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const queries = [window.matchMedia(WIDE_QUERY), window.matchMedia(MEDIUM_QUERY)];
  for (const query of queries) query.addEventListener("change", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, currentMode, currentMode);
}

/** Date.now(), refreshed every `intervalMs` (for "3 minutes ago"). */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
