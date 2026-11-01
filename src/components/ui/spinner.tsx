import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const spinnerVariants = cva("efre-essential-motion animate-spin text-current", {
  variants: {
    size: { sm: "size-3.5", md: "size-4", lg: "size-6" },
  },
  defaultVariants: { size: "md" },
});

interface SpinnerProps extends Omit<ComponentProps<"svg">, "children">, VariantProps<typeof spinnerVariants> {
  /** Announced to screen readers. Omit when the surrounding control already says what's happening. */
  label?: string;
}

/** A small progress ring. It keeps turning (slowly) under reduced motion: it signals progress. */
export function Spinner({ className, size, label, ...props }: SpinnerProps) {
  const svg = (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.75" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
  if (label === undefined) return svg;
  return (
    <span role="status" className="inline-flex items-center">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
