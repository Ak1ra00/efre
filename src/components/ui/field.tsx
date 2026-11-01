import { CircleAlert } from "lucide-react";
import { type ReactNode, useId } from "react";

import { cn } from "@/lib/utils";

import { Label } from "./label";

/** Props a Field hands to its control so label, hint and error are wired for screen readers. */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

interface FieldProps {
  label: ReactNode;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Inline validation message; marks the control invalid. */
  error?: ReactNode;
  /** Extra content on the label row (e.g. a "Generate" button). */
  labelAction?: ReactNode;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label + control + hint/error, with ids wired up:
 * `<Field label="Nickname" error={err}>{(p) => <Input {...p} />}</Field>`
 */
export function Field({ label, hint, error, labelAction, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== "";
  const describedBy = [hasError ? errorId : null, hasHint ? hintId : null].filter(Boolean).join(" ");
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {labelAction}
      </div>
      {children({
        id,
        "aria-describedby": describedBy === "" ? undefined : describedBy,
        "aria-invalid": hasError ? true : undefined,
      })}
      {hasError ? (
        <p id={errorId} className="flex items-start gap-1.5 text-[13px] text-danger-text">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
      {hasHint ? (
        <p id={hintId} className="text-[13px] text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
