import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { REVEAL_SECONDS } from "@/lib/defaults";
import type { FieldView } from "@/lib/ipc-types";
import { FIELD_KINDS } from "@/lib/items";
import { cn } from "@/lib/utils";

import { useReveal } from "./use-reveal";
import { useVault } from "./vault-context";

/** The label to show for a field (labels may be empty). */
export function fieldLabel(field: Pick<FieldView, "label" | "kind">): string {
  const label = field.label.trim();
  return label === "" ? FIELD_KINDS[field.kind].label : label;
}

/** Copy in Rust (copy_field), with a check mark for a moment afterwards. */
export function CopyFieldButton({ itemId, field }: { itemId: string; field: FieldView }) {
  const { actions } = useVault();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  const label = `Copy ${fieldLabel(field)}`;
  return (
    <Tip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        onClick={() => {
          void actions.copyField(itemId, { id: field.id, label: fieldLabel(field) }).then((ok) => {
            if (!ok) return;
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              setCopied(false);
            }, 1500);
          });
        }}
      >
        {copied ? <Check aria-hidden="true" className="text-success-text" /> : <Copy aria-hidden="true" />}
      </Button>
    </Tip>
  );
}

/** One field of the opened item: label, value and its actions. */
export function FieldRow({ itemId, field }: { itemId: string; field: FieldView }) {
  if (field.kind === "hidden") return <HiddenFieldRow itemId={itemId} field={field} />;
  const value = field.value ?? "";
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <dt className="text-xs font-medium text-fg-subtle">{fieldLabel(field)}</dt>
        <dd
          className={cn(
            "mt-1 text-sm text-fg",
            field.kind === "multiline" ? "whitespace-pre-wrap break-words" : "break-words",
            field.kind === "url" && "break-all",
          )}
        >
          {value}
        </dd>
      </div>
      <div className="-my-0.5 flex shrink-0 items-center gap-1">
        <CopyFieldButton itemId={itemId} field={field} />
      </div>
    </div>
  );
}

function HiddenFieldRow({ itemId, field }: { itemId: string; field: FieldView }) {
  const { actions } = useVault();
  const label = fieldLabel(field);
  const reveal = useReveal(itemId, field.id, (err) => {
    actions.report(err, `Couldn't reveal ${label}`);
  });
  const shown = reveal.value !== null;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <dt className="text-xs font-medium text-fg-subtle">{label}</dt>
        <dd className="mt-1 text-sm">
          {shown ? (
            <>
              {/* Not selectable: copying goes through Rust, which keeps it out of clipboard history. */}
              <span className="font-mono break-all text-fg select-none">{reveal.value}</span>
              <span className="sr-only"> (hides after {REVEAL_SECONDS} seconds)</span>
              <RevealCountdown remaining={reveal.remaining} />
            </>
          ) : (
            <>
              <span aria-hidden="true" className="font-mono tracking-[0.18em] text-fg-muted select-none">
                ••••••••••
              </span>
              <span className="sr-only">Hidden</span>
            </>
          )}
        </dd>
      </div>
      <div className="-my-0.5 flex shrink-0 items-center gap-1">
        <Tip label={shown ? `Hide ${label}` : `Reveal ${label}`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={shown ? `Hide ${label}` : `Reveal ${label}`}
            loading={reveal.loading}
            onClick={() => {
              if (shown) reveal.hide();
              else void reveal.reveal();
            }}
          >
            {reveal.loading ? null : shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        </Tip>
        <CopyFieldButton itemId={itemId} field={field} />
      </div>
    </div>
  );
}

function RevealCountdown({ remaining }: { remaining: number }) {
  const fraction = Math.min(1, remaining / REVEAL_SECONDS);
  return (
    <span aria-hidden="true" className="mt-2 flex items-center gap-2">
      <span className="h-0.5 flex-1 overflow-hidden rounded-full bg-line-strong">
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
          style={{ width: `${String(fraction * 100)}%` }}
        />
      </span>
      <span className="text-xs text-fg-subtle tabular-nums">Hides in {remaining} s</span>
    </span>
  );
}
