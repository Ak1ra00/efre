import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, e.g. "New item". */
  action?: ReactNode;
  className?: string;
}

/** Thoughtful empty states (SPEC §7): what this place is for and what to do next. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      {Icon === undefined ? null : (
        <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-line bg-elevated text-fg-subtle shadow-highlight">
          <Icon aria-hidden="true" className="size-5" />
        </div>
      )}
      <div className="flex max-w-xs flex-col gap-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description === undefined ? null : <p className="text-[13px] text-fg-muted">{description}</p>}
      </div>
      {action === undefined ? null : <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  );
}
