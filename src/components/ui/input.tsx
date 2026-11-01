import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** Shared look of text controls; `aria-invalid` turns the border red (inline validation). */
export const fieldControlClass = cn(
  "w-full min-w-0 rounded-md border border-control bg-canvas/60 px-2.5 text-sm text-fg",
  "placeholder:text-fg-subtle transition-[border-color,background-color] duration-150",
  "hover:border-control-hover focus-visible:border-accent focus-visible:bg-canvas focus-visible:outline-offset-0",
  "disabled:cursor-not-allowed disabled:border-line disabled:text-fg-disabled",
  "aria-invalid:border-danger-text aria-invalid:focus-visible:outline-danger-text",
);

/**
 * Text input. efre turns off autocomplete, autocorrect and spellcheck by default so the
 * WebView never keeps or sends what you type; override per field only for plain text.
 */
export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className={cn(fieldControlClass, "h-8 py-1", type === "file" && "py-1.5", className)}
      {...props}
    />
  );
}
