/** Settings › Auto-lock & clipboard: the two timers (stored encrypted in the vault). */
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { toastError } from "@/app/toast-error";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AUTO_LOCK_PRESETS, CLIPBOARD_PRESETS, formatMinutes, formatSeconds } from "@/lib/defaults";
import { ipc } from "@/lib/ipc";
import type { Settings } from "@/lib/ipc-types";

import { SectionHeader } from "./section";

/** "30 seconds", "1 minute", "90 seconds", "2 minutes". */
export function formatClipboardSeconds(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? formatMinutes(seconds / 60) : formatSeconds(seconds);
}

/** The presets, plus the current value if it isn't one of them (set by an older efre). */
function options(presets: readonly number[], current: number): number[] {
  return presets.includes(current) ? [...presets] : [...presets, current].sort((a, b) => a - b);
}

export function TimersSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState<keyof Settings | null>(null);
  // Only the reply to the latest change counts (an older, slower one must not win).
  const generation = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let cancelled = false;
    ipc.getSettings().then(
      (loaded) => {
        if (!cancelled) setSettings(loaded);
      },
      (err: unknown) => {
        if (cancelled) return;
        setFailed(true);
        toastError(err, "Couldn't load the timers");
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(savedTimer.current);
    };
  }, []);

  const save = async (field: keyof Settings, value: number) => {
    if (settings === null || settings[field] === value) return;
    const previous = settings;
    const next = { ...settings, [field]: value };
    generation.current += 1;
    const mine = generation.current;
    setSettings(next);
    setSaved(null);
    try {
      const stored = await ipc.setSettings(next);
      if (mine !== generation.current) return;
      setSettings(stored);
      setSaved(field);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => {
        setSaved(null);
      }, 2000);
    } catch (err: unknown) {
      if (mine === generation.current) setSettings(previous);
      toastError(err, "Couldn't save the setting");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Auto-lock & clipboard"
        description="How long efre stays open while you're away, and how long a copied value stays on the clipboard."
      />
      {settings === null ? (
        failed ? (
          <p className="text-sm text-fg-muted">The timers couldn't be loaded. Close Settings and try again.</p>
        ) : (
          <div className="flex flex-col gap-6" aria-busy="true">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        )
      ) : (
        <div className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface shadow-highlight">
          <TimerRow
            label="Lock after inactivity"
            hint="efre also locks when your PC sleeps, when Windows locks, and when no YubiKey is plugged in."
            value={settings.autoLockMinutes}
            choices={options(AUTO_LOCK_PRESETS, settings.autoLockMinutes)}
            format={formatMinutes}
            saved={saved === "autoLockMinutes"}
            onChange={(value) => {
              void save("autoLockMinutes", value);
            }}
          />
          <TimerRow
            label="Clear the clipboard after"
            hint="Only if it still holds what efre copied. efre also clears it when it locks or quits."
            value={settings.clipboardClearSeconds}
            choices={options(CLIPBOARD_PRESETS, settings.clipboardClearSeconds)}
            format={formatClipboardSeconds}
            saved={saved === "clipboardClearSeconds"}
            onChange={(value) => {
              void save("clipboardClearSeconds", value);
            }}
          />
        </div>
      )}
    </div>
  );
}

interface TimerRowProps {
  label: string;
  hint: string;
  value: number;
  choices: readonly number[];
  format: (value: number) => string;
  saved: boolean;
  onChange: (value: number) => void;
}

function TimerRow({ label, hint, value, choices, format, saved, onChange }: TimerRowProps) {
  return (
    <div className="px-4 py-4">
      <Field
        label={label}
        hint={hint}
        labelAction={
          <span aria-live="polite" className="inline-flex h-5 items-center gap-1 text-[13px] text-success-text">
            {saved ? (
              <>
                <Check aria-hidden="true" className="size-3.5" />
                Saved
              </>
            ) : null}
          </span>
        }
      >
        {(control) => (
          <Select
            value={String(value)}
            onValueChange={(next) => {
              onChange(Number(next));
            }}
          >
            <SelectTrigger {...control} className="sm:max-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem key={choice} value={String(choice)}>
                  {format(choice)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    </div>
  );
}
