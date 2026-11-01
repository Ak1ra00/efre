import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "bg-hover text-fg-muted",
        accent: "bg-accent-soft text-accent-text",
        success: "bg-success-soft text-success-text",
        warning: "bg-warning-soft text-warning-text",
        danger: "bg-danger-soft text-danger-text",
        outline: "border border-line-strong text-fg-muted",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

/** Small label: tags, counts, states ("Trash", "Very strong"). */
export function Badge({ className, variant, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
