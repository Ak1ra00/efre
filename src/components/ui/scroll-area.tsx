import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

interface ScrollAreaProps extends ComponentProps<"div"> {
  /** Scroll direction (default vertical). */
  orientation?: "vertical" | "horizontal" | "both";
}

/**
 * A scroll container with thin, dark native scrollbars.
 *
 * This is deliberately not Radix ScrollArea: Radix injects an inline <style> element,
 * which efre's CSP (style-src 'self') blocks. Native scrolling keeps keyboard, wheel,
 * touchpad and screen-reader behaviour intact, and it is the element to hand to
 * @tanstack/react-virtual as the scroll element (pass a `ref`).
 */
export function ScrollArea({ className, orientation = "vertical", tabIndex, ...props }: ScrollAreaProps) {
  return (
    <div
      // Scrollable regions must be reachable by keyboard (WCAG 2.1.1).
      tabIndex={tabIndex ?? 0}
      className={cn(
        "relative min-h-0 overscroll-contain focus-visible:outline-offset-[-2px]",
        orientation === "vertical" && "overflow-x-hidden overflow-y-auto",
        orientation === "horizontal" && "overflow-x-auto overflow-y-hidden",
        orientation === "both" && "overflow-auto",
        className,
      )}
      {...props}
    />
  );
}
