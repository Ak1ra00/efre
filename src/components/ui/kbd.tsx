import type { ComponentProps } from "react";

import { formatShortcut, shortcutKeys } from "@/lib/shortcut";
import { cn } from "@/lib/utils";

/** One key cap. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-hover px-1",
        "font-sans text-[11px] leading-none font-medium text-fg-muted shadow-[inset_0_-1px_0_rgb(0_0_0/0.3)]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A whole combo in Windows notation: `<KbdCombo combo="Ctrl+K" />` renders Ctrl + K key caps.
 * Screen readers hear "Ctrl+K".
 */
export function KbdCombo({ combo, className }: { combo: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="sr-only">{formatShortcut(combo)}</span>
      {shortcutKeys(combo).map((key, index) => (
        <Kbd key={`${String(index)}-${key}`} aria-hidden="true">
          {key}
        </Kbd>
      ))}
    </span>
  );
}
