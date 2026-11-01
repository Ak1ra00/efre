/**
 * The Windows Security companion, shared by setup, unlock and settings.
 *
 * Every command that shows a Windows Security prompt (docs/IPC.md, "Prompts") runs
 * through `useKeyPrompt().run(...)`. While it runs, <KeyPromptOverlay> tells the user
 * what Windows is about to ask for — which key, its PIN or fingerprint, then a touch —
 * from the `key-step` event Rust emits before each prompt, and offers Cancel
 * (`cancel_prompt`). The overlay sits in the upper part of the window, so it stays
 * readable above the Windows Security dialog, which Windows centres on efre's window.
 */
import { ArrowRight, Check, FingerprintPattern, Hand, RectangleEllipsis } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { describeKeyStep, IpcError, ipc, toIpcError } from "@/lib/ipc";
import type { KeyStep } from "@/lib/ipc-types";
import { useIpcEvent } from "@/lib/use-ipc-event";
import { cn } from "@/lib/utils";

/** How a prompting command ended. */
export type KeyPromptResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: IpcError;
      /** The user pressed Cancel in efre: show nothing alarming. */
      cancelledByUser: boolean;
    };

export interface KeyPrompt {
  /** A prompting command is running (the overlay is up). */
  active: boolean;
  /** Every `key-step` seen during this run, in order; the last one is current. */
  seen: readonly KeyStep[];
  /** The user pressed Cancel and efre is waiting for Windows to close its prompt. */
  cancelling: boolean;
  /** Runs a prompting command with the overlay up. Never rejects. */
  run: <T>(command: () => Promise<T>) => Promise<KeyPromptResult<T>>;
  /** Asks Rust to close the open Windows Security prompt; the command then fails with authn.cancelled. */
  cancel: () => void;
}

interface PromptState {
  active: boolean;
  seen: readonly KeyStep[];
  cancelling: boolean;
}

const IDLE: PromptState = { active: false, seen: [], cancelling: false };

/** Re-sends cancel_prompt this long after a new prompt starts while the user is cancelling. */
const CANCEL_RETRY_MS = 400;

const isSet = (flag: { current: boolean }) => flag.current;

export function useKeyPrompt(): KeyPrompt {
  const [state, setState] = useState<PromptState>(IDLE);
  const running = useRef(false);
  const cancelRequested = useRef(false);

  const sendCancel = useCallback(() => {
    // A failed cancel needs no handling: the command still ends, with or without it.
    ipc.cancelPrompt().catch(() => undefined);
  }, []);

  useIpcEvent("key-step", (step) => {
    if (!running.current) return;
    setState((s) => ({ ...s, seen: [...s.seen, step] }));
    if (cancelRequested.current) {
      // Cancel was pressed between two prompts: close the next one as soon as it opens.
      sendCancel();
      setTimeout(() => {
        if (running.current && cancelRequested.current) sendCancel();
      }, CANCEL_RETRY_MS);
    }
  });

  const run = useCallback(async <T,>(command: () => Promise<T>): Promise<KeyPromptResult<T>> => {
    if (running.current) {
      return {
        ok: false,
        error: new IpcError("invalid", "A Windows Security prompt is already open."),
        cancelledByUser: false,
      };
    }
    running.current = true;
    cancelRequested.current = false;
    setState({ active: true, seen: [], cancelling: false });
    try {
      return { ok: true, value: await command() };
    } catch (raw: unknown) {
      const error = toIpcError(raw);
      // Read through a function: the ref changed while the command was running.
      return { ok: false, error, cancelledByUser: isSet(cancelRequested) && error.code === "authn.cancelled" };
    } finally {
      running.current = false;
      cancelRequested.current = false;
      setState(IDLE);
    }
  }, []);

  const cancel = useCallback(() => {
    if (!running.current) return;
    cancelRequested.current = true;
    setState((s) => ({ ...s, cancelling: true }));
    sendCancel();
  }, [sendCancel]);

  return { ...state, run, cancel };
}

/* ----------------------------------------------------------------------------------- */
/* Progress rows                                                                        */
/* ----------------------------------------------------------------------------------- */

export interface PromptRow {
  label: string;
  state: "done" | "current" | "pending";
}

/** Rows for a flow whose prompts always come in the same order (one label per prompt). */
export function sequentialRows(labels: readonly string[], seen: number): PromptRow[] {
  return labels.map((label, index) => ({
    label,
    state: index < seen - 1 ? "done" : index === seen - 1 ? "current" : "pending",
  }));
}

/**
 * Rows for removing a key: one per remaining key, in the order Rust asks for them. Keys
 * Rust already asked for come first (named exactly as in its `useKey` events), then the
 * ones still to come.
 */
export function keyRows(remaining: readonly string[], seen: readonly KeyStep[]): PromptRow[] {
  const asked = seen.flatMap((step) => (step.step === "useKey" ? [step.nickname] : []));
  const pending = [...remaining];
  for (const name of asked) {
    const at = pending.indexOf(name);
    if (at !== -1) pending.splice(at, 1);
  }
  return [
    ...asked.map((label, index): PromptRow => ({ label, state: index < asked.length - 1 ? "done" : "current" })),
    ...pending.map((label): PromptRow => ({ label, state: "pending" })),
  ];
}

/* ----------------------------------------------------------------------------------- */
/* Overlay                                                                              */
/* ----------------------------------------------------------------------------------- */

interface KeyPromptOverlayProps {
  prompt: KeyPrompt;
  /** Number of prompts the command shows, for "Step 2 of 3". Omit when it is one. */
  total?: number;
  /** Progress rows for a multi-prompt flow. */
  rows?: (seen: readonly KeyStep[]) => readonly PromptRow[];
  /** Nicknames of the enrolled keys, for "any enrolled key works". */
  enrolledKeys?: readonly string[];
  /** An extra line about this flow (e.g. "swapping keys is fine"). */
  note?: ReactNode;
}

const listFormat = new Intl.ListFormat("en", { type: "disjunction" });

/** One line of extra guidance for a step, on top of describeKeyStep. */
function stepHint(step: KeyStep, enrolledKeys: readonly string[]): string | null {
  switch (step.step) {
    case "useEnrolledKey":
      return enrolledKeys.length > 0 ? `Any enrolled key works: ${listFormat.format(enrolledKeys)}.` : null;
    case "createCredential":
      return "Plug in the key you're adding. Windows may first ask you to touch it.";
    case "confirmNewKey":
      return "Same key again: keep it plugged in.";
    case "useKey":
      return `Plug in “${step.nickname}” if it isn't already.`;
  }
}

/**
 * What Windows is asking for, while a prompting command runs. Esc and Cancel close the
 * Windows Security prompt (cancel_prompt); clicking outside does nothing.
 */
export function KeyPromptOverlay({ prompt, total, rows, enrolledKeys = [], note }: KeyPromptOverlayProps) {
  const current = prompt.seen.at(-1) ?? null;
  const copy =
    current === null
      ? { title: "Waiting for Windows Security…", description: "Its window opens in a moment." }
      : describeKeyStep(current);
  const hint = current === null ? null : stepHint(current, enrolledKeys);
  const stepNumber = Math.max(prompt.seen.length, 1);
  const progress = rows?.(prompt.seen) ?? [];
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <Dialog open={prompt.active}>
      <DialogContent
        ref={contentRef}
        size="sm"
        showClose={false}
        // Upper third: the Windows Security dialog opens centred over efre's window.
        className="top-[8%] translate-y-0 sm:top-[12%]"
        onOpenAutoFocus={(event) => {
          // Focus the panel, not Cancel, so a repeated Enter can't cancel by accident.
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          prompt.cancel();
        }}
        onPointerDownOutside={(event) => {
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-4 px-6 pt-6 pb-5">
          <div className="flex items-center gap-3">
            <PromptGlyph />
            <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
              Windows Security
              {total !== undefined && total > 1 ? (
                <span className="text-fg-muted">
                  {" "}
                  · Step {Math.min(stepNumber, total)} of {total}
                </span>
              ) : null}
            </p>
          </div>

          <div className="flex flex-col gap-1.5" aria-live="polite">
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
            {hint === null ? null : <p className="text-sm text-fg-muted">{hint}</p>}
          </div>

          <PinThenTouch />

          {note === undefined ? null : (
            <div className="rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-fg-muted">{note}</div>
          )}

          {progress.length === 0 ? null : (
            <ol aria-label="Progress" className="flex flex-col gap-1">
              {progress.map((row, index) => (
                <li
                  key={`${String(index)}-${row.label}`}
                  aria-current={row.state === "current" ? "step" : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px]",
                    row.state === "current" ? "bg-accent-soft text-fg" : "text-fg-muted",
                  )}
                >
                  <RowMarker state={row.state} index={index} />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <span className="sr-only">
                    {row.state === "done" ? "(done)" : row.state === "current" ? "(now)" : "(next)"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-line px-6 py-3">
          <p className="text-[13px] text-fg-subtle">Follow the Windows Security window.</p>
          <Button loading={prompt.cancelling} onClick={prompt.cancel}>
            {prompt.cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RowMarker({ state, index }: { state: PromptRow["state"]; index: number }) {
  if (state === "done") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success-text">
        <Check aria-hidden="true" className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center text-accent-text">
        <Spinner size="sm" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong text-[11px] font-medium text-fg-subtle"
    >
      {index + 1}
    </span>
  );
}

/** "PIN or fingerprint → touch": what every Windows Security prompt asks for. */
function PinThenTouch() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
      <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2">
        <RectangleEllipsis aria-hidden="true" className="size-3.5 text-fg-subtle" />
        PIN
        <span className="text-fg-subtle">or</span>
        <FingerprintPattern aria-hidden="true" className="size-3.5 text-fg-subtle" />
        fingerprint
      </span>
      <ArrowRight aria-hidden="true" className="size-3.5 text-fg-subtle" />
      <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2">
        <Hand aria-hidden="true" className="size-3.5 text-fg-subtle" />
        Touch the key when it blinks
      </span>
    </div>
  );
}

/** A small key with a soft pulse (still under reduced motion). */
function PromptGlyph() {
  const reduce = useReducedMotion() === true;
  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface shadow-highlight">
      {reduce ? null : (
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 rounded-lg border border-accent/60"
          initial={{ opacity: 0.6, scale: 1 }}
          animate={{ opacity: 0, scale: 1.35 }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="none">
        <rect x="3" y="7.5" width="14" height="9" rx="3" stroke="currentColor" className="text-fg-muted" strokeWidth="1.5" />
        <path d="M17 10.5h3a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-3" stroke="currentColor" className="text-fg-subtle" strokeWidth="1.5" />
        <circle cx="9" cy="12" r="2" fill="currentColor" className="text-accent" />
      </svg>
    </span>
  );
}
