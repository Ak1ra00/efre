import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

const alertVariants = cva("flex items-start gap-3 rounded-lg border px-3.5 py-3 text-sm", {
  variants: {
    variant: {
      info: "border-line bg-elevated text-fg",
      warning: "border-warning-text/25 bg-warning-soft text-fg",
      danger: "border-danger-text/25 bg-danger-soft text-fg",
    },
  },
  defaultVariants: { variant: "info" },
});

const icons = {
  info: <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-text" />,
  warning: <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-text" />,
  danger: <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-text" />,
} as const;

interface AlertProps extends Omit<ComponentProps<"div">, "title">, VariantProps<typeof alertVariants> {
  title?: ReactNode;
  /** Buttons on the right. */
  action?: ReactNode;
}

/**
 * Inline callout: banners, inline errors, warnings. It is not announced by default;
 * pass `role="alert"` for an error that appears in response to an action.
 */
export function Alert({ className, variant, title, action, children, ...props }: AlertProps) {
  return (
    <div className={cn(alertVariants({ variant }), className)} {...props}>
      {icons[variant ?? "info"]}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title === undefined ? null : <p className="font-medium text-fg">{title}</p>}
        {children === undefined ? null : <div className="text-[13px] text-fg-muted">{children}</div>}
      </div>
      {action === undefined ? null : <div className="flex shrink-0 items-center gap-2 self-center">{action}</div>}
    </div>
  );
}
