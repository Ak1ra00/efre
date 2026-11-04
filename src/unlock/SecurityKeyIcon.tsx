import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A small USB security key (lucide-style line icon, 24 × 24, currentColor): a body with
 * a touch pad and a plug. Original artwork, no maker's logo. Decorative.
 */
export function SecurityKeyIcon({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-4", className)}
      {...props}
    >
      <rect x="2.5" y="7" width="15" height="10" rx="3" />
      <path d="M17.5 10h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-3" />
      <circle cx="9" cy="12" r="2" />
    </svg>
  );
}
