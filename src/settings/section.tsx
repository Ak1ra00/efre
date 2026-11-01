import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** The title row of a settings section. */
export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-base leading-6 font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-fg-muted text-pretty">{description}</p>
      </div>
      {/* Clear of the dialog's close button (top right) on wide windows. */}
      {action === undefined ? null : <div className="flex shrink-0 gap-2 sm:mr-9">{action}</div>}
    </div>
  );
}

/** A titled group inside a section. */
export function SettingsGroup({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <h3 className="text-[13px] font-medium text-fg-subtle">{title}</h3>
      {children}
    </section>
  );
}
