import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** efre's name in Tifinagh, the Amazigh script: ⵉⴼⵔⵉ (ifri), "cave" in Tamazight. */
export const EFRE_TIFINAGH = "ⵉⴼⵔⵉ";

/** The plural, ⵉⴼⵔⴰⵏ (ifran), "caves". */
export const IFRAN_TIFINAGH = "ⵉⴼⵔⴰⵏ";

/**
 * ⵉⴼⵔⵉ, set in the bundled Noto Sans Tifinagh (Windows' Ebrima is the fallback).
 *
 * Decorative by default, because it sits next to the Latin name "efre". Pass `label` when
 * it stands on its own, so a screen reader says "ifri" instead of spelling out letter names.
 */
export function TifinaghName({
  className,
  label,
  ...props
}: Omit<ComponentProps<"span">, "children"> & { label?: string }) {
  return (
    <span
      lang="ber-Tfng"
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      className={cn("font-tifinagh", className)}
      {...props}
    >
      {EFRE_TIFINAGH}
    </span>
  );
}
