import { useEffect, useRef, useState } from "react";

import { REVEAL_SECONDS } from "@/lib/defaults";
import { ipc } from "@/lib/ipc";

export interface Reveal {
  /** The secret while it is shown, else null. */
  value: string | null;
  /** Whole seconds until it hides again. */
  remaining: number;
  loading: boolean;
  reveal: () => Promise<void>;
  hide: () => void;
}

/**
 * Reveals one hidden field (SPEC §5): the value comes from Rust only on this explicit
 * action, shows for REVEAL_SECONDS and then hides. It also hides as soon as efre loses
 * focus or is minimised, and when the field unmounts (another item, edit, lock), since
 * the value lives only in this hook's state.
 */
export function useReveal(itemId: string, fieldId: number, onError: (err: unknown) => void): Reveal {
  const [revealed, setRevealed] = useState<{ value: string; hideAt: number } | null>(null);
  const [now, setNow] = useState(0);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (revealed === null) return;
    const hide = () => {
      setRevealed(null);
    };
    const tick = setInterval(() => {
      const t = Date.now();
      if (t >= revealed.hideAt) hide();
      else setNow(t);
    }, 250);
    const timeout = setTimeout(hide, Math.max(0, revealed.hideAt - Date.now()));
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(tick);
      clearTimeout(timeout);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [revealed]);

  const reveal = async () => {
    setLoading(true);
    try {
      const value = await ipc.revealField(itemId, fieldId);
      if (!mounted.current) return;
      const t = Date.now();
      setNow(t);
      setRevealed({ value, hideAt: t + REVEAL_SECONDS * 1000 });
    } catch (err: unknown) {
      if (mounted.current) onError(err);
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  return {
    value: revealed?.value ?? null,
    remaining: revealed === null ? 0 : Math.max(0, Math.ceil((revealed.hideAt - now) / 1000)),
    loading,
    reveal,
    hide: () => {
      setRevealed(null);
    },
  };
}
