import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

import { KbdCombo } from "./kbd";

/** Mounted once by the app shell. */
export function TooltipProvider({ delayDuration = 500, skipDelayDuration = 300, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 flex max-w-72 items-center gap-2 rounded-md border border-line-strong bg-elevated px-2 py-1 text-xs text-fg shadow-popover",
          "origin-(--radix-tooltip-content-transform-origin) data-[state=closed]:animate-fade-out data-[state=delayed-open]:animate-pop-in data-[state=instant-open]:animate-fade-in",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

interface TipProps {
  /** The hint text. For icon buttons, also give the button the same `aria-label`. */
  label: ReactNode;
  /** Optional shortcut shown after the label, e.g. "Ctrl+L". */
  shortcut?: string;
  side?: ComponentProps<typeof TooltipPrimitive.Content>["side"];
  /** One focusable child (it becomes the trigger). */
  children: ReactElement;
}

/** Shorthand: `<Tip label="Lock" shortcut="Ctrl+L"><Button size="icon" aria-label="Lock">…</Button></Tip>`. */
export function Tip({ label, shortcut, side = "bottom", children }: TipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span>{label}</span>
        {shortcut === undefined ? null : <KbdCombo combo={shortcut} />}
      </TooltipContent>
    </Tooltip>
  );
}
