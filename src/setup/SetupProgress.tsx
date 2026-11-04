import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export type StepId = "welcome" | "how" | "primary" | "backup" | "done";

export const SETUP_STEPS: readonly { id: StepId; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "how", label: "How it works" },
  { id: "primary", label: "Primary key" },
  { id: "backup", label: "Backup key" },
  { id: "done", label: "Done" },
];

/** The wizard's five steps; the current one is marked for screen readers too. */
export function SetupProgress({ current }: { current: StepId }) {
  const currentIndex = SETUP_STEPS.findIndex((step) => step.id === current);
  return (
    <nav aria-label="Setup progress">
      <ol className="flex items-center justify-center gap-2">
        {SETUP_STEPS.map((step, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
          return (
            <li
              key={step.id}
              aria-current={state === "current" ? "step" : undefined}
              className="flex items-center gap-2"
            >
              {index === 0 ? null : (
                <span
                  aria-hidden="true"
                  className={cn("h-px w-4 sm:w-6", index <= currentIndex ? "bg-accent/50" : "bg-line-strong")}
                />
              )}
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                  state === "done" && "bg-accent-soft text-accent-text",
                  state === "current" && "bg-accent text-accent-fg",
                  state === "upcoming" && "border border-line-strong text-fg-subtle",
                )}
              >
                {state === "done" ? <Check aria-hidden="true" className="size-3" strokeWidth={3} /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-[13px] whitespace-nowrap",
                  state === "current" ? "font-medium text-fg" : "sr-only text-fg-subtle md:not-sr-only",
                )}
              >
                {step.label}
              </span>
              <span className="sr-only">
                {state === "done" ? "(done)" : state === "current" ? "(current step)" : "(to do)"}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
