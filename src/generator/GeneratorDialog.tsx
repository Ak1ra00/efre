/**
 * Password and passphrase generator (SPEC §6). Values are made in Rust; this dialog
 * shows the latest one with its strength. "Copy" copies in Rust (copy_generated: the
 * value Rust generated last), never through JS. When opened with
 * `requestGenerator(onUse)`, "Use" hands the value to the caller (e.g. the item editor).
 *
 * Only one generate request is in flight at a time and the latest options win, so the
 * value on screen is always the one Rust would copy. The value is dropped when the
 * dialog closes; the options stay for the session.
 */
import { Check, Copy, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import { toastError } from "@/app/toast-error";
import { useUIState } from "@/app/ui-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tip } from "@/components/ui/tooltip";
import { toast } from "@/components/ui/use-toast";
import {
  DEFAULT_PASSPHRASE_OPTIONS,
  DEFAULT_PASSWORD_OPTIONS,
  formatMinutes,
  formatSeconds,
  PASSPHRASE_SEPARATOR_MAX,
  PASSPHRASE_WORDS,
  PASSWORD_LENGTH,
} from "@/lib/defaults";
import { friendlyError, ipc } from "@/lib/ipc";
import type { Generated, PassphraseOptions, PasswordOptions } from "@/lib/ipc-types";
import { cn } from "@/lib/utils";

import { StrengthMeter } from "./StrengthMeter";

type Mode = "password" | "passphrase";
type Request = { mode: "password"; options: PasswordOptions } | { mode: "passphrase"; options: PassphraseOptions };

const CLASSES = [
  { key: "uppercase", label: "Uppercase", sample: "A–Z" },
  { key: "lowercase", label: "Lowercase", sample: "a–z" },
  { key: "digits", label: "Digits", sample: "0–9" },
  { key: "symbols", label: "Symbols", sample: "!#$%" },
] as const;

// Control characters can't be part of a separator (Rust refuses them).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const clearsIn = (seconds: number) =>
  seconds >= 60 && seconds % 60 === 0 ? formatMinutes(seconds / 60) : formatSeconds(seconds);

export function GeneratorDialog() {
  const { generatorOpen, generatorOnUse, closeGenerator } = useUIState();
  const [mode, setMode] = useState<Mode>("password");
  const [password, setPassword] = useState<PasswordOptions>({ ...DEFAULT_PASSWORD_OPTIONS });
  const [passphrase, setPassphrase] = useState<PassphraseOptions>({ ...DEFAULT_PASSPHRASE_OPTIONS });
  return (
    <Dialog
      open={generatorOpen}
      onOpenChange={(open) => {
        if (!open) closeGenerator();
      }}
    >
      <DialogContent size="md">
        <GeneratorPanel
          mode={mode}
          onModeChange={setMode}
          password={password}
          onPasswordChange={setPassword}
          passphrase={passphrase}
          onPassphraseChange={setPassphrase}
          onUse={generatorOnUse}
          onClose={closeGenerator}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Serialized generation: one request in flight; while it runs, only the newest waits. */
function useGenerator() {
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queued = useRef<Request | null>(null);
  const running = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const generate = useCallback((request: Request) => {
    queued.current = request;
    setPending(true);
    if (running.current) return;
    running.current = true;
    // Read the refs through functions: they change while a request is awaited.
    const take = () => {
      const next = alive.current ? queued.current : null;
      queued.current = null;
      return next;
    };
    const current = () => alive.current && queued.current === null;
    void (async () => {
      for (let next = take(); next !== null; next = take()) {
        let result: Generated | null = null;
        let failure: string | null = null;
        try {
          result =
            next.mode === "password"
              ? await ipc.generatePassword(next.options)
              : await ipc.generatePassphrase(next.options);
        } catch (err: unknown) {
          failure = friendlyError(err).description;
        }
        // Skip it if a newer request is waiting: this value is already out of date.
        if (current()) {
          setGenerated(result);
          setError(failure);
        }
      }
      running.current = false;
      if (alive.current) setPending(false);
    })();
  }, []);

  return { generated, pending, error, generate };
}

interface GeneratorPanelProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  password: PasswordOptions;
  onPasswordChange: (options: PasswordOptions) => void;
  passphrase: PassphraseOptions;
  onPassphraseChange: (options: PassphraseOptions) => void;
  onUse: ((value: string) => void) | null;
  onClose: () => void;
}

function GeneratorPanel({
  mode,
  onModeChange,
  password,
  onPasswordChange,
  passphrase,
  onPassphraseChange,
  onUse,
  onClose,
}: GeneratorPanelProps) {
  const { generated, pending, error, generate } = useGenerator();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const noun = mode === "password" ? "password" : "passphrase";

  const regenerate = useCallback(() => {
    generate(mode === "password" ? { mode, options: password } : { mode, options: passphrase });
  }, [generate, mode, password, passphrase]);

  // A fresh value on open and whenever an option changes.
  useEffect(() => {
    regenerate();
  }, [regenerate]);

  useEffect(
    () => () => {
      clearTimeout(copiedTimer.current);
    },
    [],
  );

  const ready = generated !== null && !pending;

  const copy = async () => {
    try {
      const { clearsInSeconds } = await ipc.copyGenerated();
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        setCopied(false);
      }, 1500);
      toast({ variant: "success", title: "Copied", description: `The clipboard clears in ${clearsIn(clearsInSeconds)}.` });
    } catch (err: unknown) {
      toastError(err, "Couldn't copy");
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Password generator</DialogTitle>
        <DialogDescription>Made by efre with your PC's secure random number generator.</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-5">
        <Tabs
          value={mode}
          onValueChange={(value) => {
            if (value === "password" || value === "passphrase") onModeChange(value);
          }}
          className="flex flex-col gap-5"
        >
          <TabsList aria-label="Kind" className="self-start">
            <TabsTrigger value="password">Password</TabsTrigger>
            <TabsTrigger value="passphrase">Passphrase</TabsTrigger>
          </TabsList>

          <div className="flex flex-col gap-4">
            <div className="flex min-h-16 items-center gap-3 rounded-lg border border-line bg-canvas px-4 py-3">
              <output
                aria-label={`Generated ${noun}`}
                aria-busy={pending}
                className={cn("min-w-0 flex-1 font-mono text-base leading-6 break-all", pending && "opacity-60")}
              >
                {generated === null ? (
                  <span className="text-fg-subtle">{error === null ? "Generating…" : "—"}</span>
                ) : (
                  <GeneratedText value={generated.value} />
                )}
              </output>
              <Tip label={`Generate another ${noun}`}>
                <Button size="icon" variant="ghost" aria-label={`Generate another ${noun}`} onClick={regenerate}>
                  <RefreshCw aria-hidden="true" />
                </Button>
              </Tip>
            </div>
            {error === null ? (
              <StrengthMeter bits={generated === null ? null : generated.entropyBits} />
            ) : (
              <Alert role="alert" variant="danger" title={`Couldn't generate a ${noun}`}>
                {error}
              </Alert>
            )}
          </div>

          <TabsContent value="password" className="flex flex-col gap-5">
            <PasswordOptionsForm options={password} onChange={onPasswordChange} />
          </TabsContent>
          <TabsContent value="passphrase" className="flex flex-col gap-5">
            <PassphraseOptionsForm options={passphrase} onChange={onPassphraseChange} />
          </TabsContent>
        </Tabs>
      </DialogBody>
      <DialogFooter>
        <Button
          variant={onUse === null ? "primary" : "secondary"}
          disabled={!ready}
          onClick={() => {
            void copy();
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        {onUse === null ? null : (
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              if (generated === null) return;
              onUse(generated.value);
              onClose();
            }}
          >
            Use {noun}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** Digits in the accent colour and symbols dimmed, so look-alike characters are easier to tell apart. */
function GeneratedText({ value }: { value: string }) {
  return (
    <>
      {Array.from(value).map((char, index) => (
        <span
          key={index}
          className={/[0-9]/.test(char) ? "text-accent-text" : /\p{L}/u.test(char) ? "text-fg" : "text-fg-muted"}
        >
          {char}
        </span>
      ))}
    </>
  );
}

/* ----------------------------------------------------------------------------------- */

function PasswordOptionsForm({
  options,
  onChange,
}: {
  options: PasswordOptions;
  onChange: (options: PasswordOptions) => void;
}) {
  const enabledClasses = CLASSES.filter((c) => options[c.key]).length;
  return (
    <>
      <RangeRow
        label="Length"
        value={options.length}
        min={PASSWORD_LENGTH.min}
        max={PASSWORD_LENGTH.max}
        unit="characters"
        onChange={(length) => {
          onChange({ ...options, length });
        }}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-[13px] font-medium text-fg-muted">Characters</legend>
        <div className="grid grid-cols-2 gap-3">
          {CLASSES.map((c) => (
            <SwitchRow
              key={c.key}
              label={c.label}
              sample={c.sample}
              checked={options[c.key]}
              // At least one kind of character must stay on.
              disabled={options[c.key] && enabledClasses === 1}
              onChange={(checked) => {
                onChange({ ...options, [c.key]: checked });
              }}
            />
          ))}
        </div>
        <SwitchRow
          label="Avoid look-alikes"
          sample="I l 1 O 0"
          checked={options.avoidAmbiguous}
          onChange={(avoidAmbiguous) => {
            onChange({ ...options, avoidAmbiguous });
          }}
        />
      </fieldset>
    </>
  );
}

function PassphraseOptionsForm({
  options,
  onChange,
}: {
  options: PassphraseOptions;
  onChange: (options: PassphraseOptions) => void;
}) {
  return (
    <>
      <RangeRow
        label="Words"
        value={options.words}
        min={PASSPHRASE_WORDS.min}
        max={PASSPHRASE_WORDS.max}
        unit="words"
        onChange={(words) => {
          onChange({ ...options, words });
        }}
      />
      <Field label="Separator" hint="Up to 3 characters between words. Leave empty for none.">
        {(control) => (
          <Input
            {...control}
            value={options.separator}
            maxLength={PASSPHRASE_SEPARATOR_MAX}
            placeholder="none"
            className="w-24 font-mono"
            onChange={(event) => {
              const separator = Array.from(event.target.value.replace(CONTROL, ""))
                .slice(0, PASSPHRASE_SEPARATOR_MAX)
                .join("");
              onChange({ ...options, separator });
            }}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <SwitchRow
          label="Capitalize words"
          sample="Word"
          checked={options.capitalize}
          onChange={(capitalize) => {
            onChange({ ...options, capitalize });
          }}
        />
        <SwitchRow
          label="Include a number"
          sample="word7"
          checked={options.includeNumber}
          onChange={(includeNumber) => {
            onChange({ ...options, includeNumber });
          }}
        />
      </div>
      <p className="text-[13px] text-fg-subtle">Words come from the EFF long wordlist (7,776 words).</p>
    </>
  );
}

function RangeRow({
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-fg-muted">{label}</span>
        <span className="text-sm font-medium tabular-nums">
          {value} <span className="sr-only">{unit}</span>
        </span>
      </div>
      <Slider
        thumbLabel={`${label} (${String(min)} to ${String(max)})`}
        min={min}
        max={max}
        step={1}
        value={[value]}
        onValueChange={([next]) => {
          if (next !== undefined && next !== value) onChange(next);
        }}
      />
    </div>
  );
}

function SwitchRow({
  label,
  sample,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  sample: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
      <Label htmlFor={id} className="flex min-w-0 flex-col gap-0.5 text-sm font-normal text-fg">
        <span>{label}</span>
        <span className="font-mono text-xs text-fg-subtle">{sample}</span>
      </Label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
