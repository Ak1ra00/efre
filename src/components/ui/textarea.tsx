import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { fieldControlClass } from "./input";

/** Multi-line text. Spellcheck is off by default (it would read secrets). */
export function Textarea({ className, rows = 4, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      rows={rows}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className={cn(fieldControlClass, "block resize-y py-2 leading-5", className)}
      {...props}
    />
  );
}
