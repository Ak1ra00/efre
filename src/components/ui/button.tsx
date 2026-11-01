import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

import { Spinner } from "./spinner";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap select-none",
    "transition-[background-color,border-color,color,box-shadow] duration-150",
    "disabled:pointer-events-none disabled:text-fg-disabled aria-busy:cursor-progress",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        /** The one main action of a view. */
        primary:
          "bg-accent text-accent-fg shadow-soft hover:bg-accent-hover active:bg-accent-active disabled:bg-hover",
        /** Everyday actions. */
        secondary:
          "border border-line-strong bg-elevated text-fg shadow-highlight hover:border-control hover:bg-hover active:bg-selected disabled:border-line disabled:bg-transparent",
        /** Toolbars, icon buttons, low-emphasis actions. */
        ghost: "text-fg-muted hover:bg-hover hover:text-fg active:bg-selected",
        /** Destructive confirmations only. */
        danger:
          "bg-danger text-danger-fg shadow-soft hover:bg-danger-hover active:bg-danger-hover disabled:bg-hover",
        /** Inline text action. */
        link: "h-auto px-0 text-accent-text underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-7 px-2.5 text-[13px]",
        md: "h-8 px-3",
        lg: "h-10 px-4",
        icon: "size-8",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Render the child element (e.g. a link) with button styles. */
  asChild?: boolean;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
}

/**
 * Buttons. Icon-only buttons need an `aria-label` (and usually a `Tip`).
 * `type` defaults to "button" so nothing submits by accident.
 */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  if (asChild) {
    return (
      <Slot.Root className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size="sm" /> : null}
      {children}
    </button>
  );
}
