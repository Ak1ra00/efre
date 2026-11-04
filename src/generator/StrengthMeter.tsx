import { useId } from "react";

import { type Strength, strengthLabel } from "@/lib/defaults";
import { cn } from "@/lib/utils";

const LEVEL: Record<Strength, number> = { Weak: 1, Fair: 2, Strong: 3, "Very strong": 4 };

const HINT: Record<Strength, string> = {
  Weak: "Too easy to guess. Make it longer or add kinds of characters.",
  Fair: "Fine for low-value accounts. Longer is better.",
  Strong: "Strong enough for almost anything.",
  "Very strong": "Far beyond what anyone can guess.",
};

const BAR: Record<Strength, string> = {
  Weak: "bg-danger-text",
  Fair: "bg-warning-text",
  Strong: "bg-success-text",
  "Very strong": "bg-success-text",
};

const TEXT: Record<Strength, string> = {
  Weak: "text-danger-text",
  Fair: "text-warning-text",
  Strong: "text-success-text",
  "Very strong": "text-success-text",
};

/** Four-step strength bar from `entropyBits` (labels from docs/IPC.md). Null while generating. */
export function StrengthMeter({ bits }: { bits: number | null }) {
  const hintId = useId();
  const strength = bits === null ? null : strengthLabel(bits);
  const level = strength === null ? 0 : LEVEL[strength];
  const rounded = bits === null ? 0 : Math.round(bits);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className={cn("font-medium", strength === null ? "text-fg-subtle" : TEXT[strength])}>
          {strength ?? "Generating…"}
        </span>
        {bits === null ? null : <span className="text-fg-subtle tabular-nums">{rounded} bits of entropy</span>}
      </div>
      <div
        role="meter"
        aria-label="Strength"
        aria-valuemin={0}
        aria-valuemax={128}
        aria-valuenow={Math.min(rounded, 128)}
        aria-valuetext={strength === null ? "Generating" : `${strength}, about ${String(rounded)} bits of entropy`}
        aria-describedby={strength === null ? undefined : hintId}
        className="grid grid-cols-4 gap-1"
      >
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={cn(
              "h-1.5 rounded-full transition-colors duration-200",
              strength !== null && step <= level ? BAR[strength] : "bg-line-strong",
            )}
          />
        ))}
      </div>
      {strength === null ? null : (
        <p id={hintId} className="text-[13px] text-fg-muted">
          {HINT[strength]}
        </p>
      )}
    </div>
  );
}
