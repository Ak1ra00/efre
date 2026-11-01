/** The wizard's steps. State and IPC live in SetupWizard; these only render. */
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  HardDrive,
  KeyRound,
  KeySquare,
  type LucideIcon,
  Usb,
  WifiOff,
} from "lucide-react";
import { type ReactNode, type RefObject, useId, useState } from "react";

import { EfreMark } from "@/components/brand/logo";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { KeyInfo } from "@/lib/ipc-types";
import { ITEM_LIMITS } from "@/lib/items";
import { cn } from "@/lib/utils";
import { KeyErrorAlert, type KeyErrorCopy } from "@/unlock/key-errors";
import { nicknameError } from "@/unlock/nickname";
import { useEnterKey } from "@/unlock/use-enter-key";

type HeadingRef = RefObject<HTMLHeadingElement | null>;

interface StepFrameProps {
  headingRef: HeadingRef;
  title: string;
  description?: ReactNode;
  /** Above the title (an icon or a status chip). */
  top?: ReactNode;
  children?: ReactNode;
  /** Secondary actions, bottom left (Back, Start over). */
  secondary?: ReactNode;
  /** Main actions, bottom right. */
  primary: ReactNode;
  centered?: boolean;
}

/** Common layout: title (focused on arrival, so screen readers announce the step), body, actions. */
function StepFrame({ headingRef, title, description, top, children, secondary, primary, centered = false }: StepFrameProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-6">
      <header className={cn("flex flex-col gap-2", centered && "items-center text-center")}>
        {top}
        <h1 id={id} ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight text-balance outline-none">
          {title}
        </h1>
        {description === undefined ? null : <p className="text-fg-muted text-pretty">{description}</p>}
      </header>
      {children}
      <footer
        className={cn(
          "flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:items-center",
          secondary === undefined ? "sm:justify-end" : "sm:justify-between",
          centered && secondary === undefined && "sm:justify-center",
        )}
      >
        {secondary === undefined ? null : <div className="flex flex-col gap-2 sm:flex-row">{secondary}</div>}
        <div className="flex flex-col gap-2 sm:flex-row">{primary}</div>
      </footer>
    </section>
  );
}

/* ----------------------------------------------------------------------------------- */

export function WelcomeStep({
  headingRef,
  notice,
  onNext,
}: {
  headingRef: HeadingRef;
  notice: string | null;
  onNext: () => void;
}) {
  return (
    <StepFrame
      centered
      headingRef={headingRef}
      top={<EfreMark className="mb-2 size-14" />}
      title="Welcome to efre"
      description="A private vault on this PC that opens only with your YubiKey."
      primary={
        <Button variant="primary" size="lg" onClick={onNext}>
          Get started
          <ArrowRight aria-hidden="true" />
        </Button>
      }
    >
      {notice === null ? null : (
        <Alert variant="info" title="Setup started over">
          {notice}
        </Alert>
      )}
      <div className="rounded-xl border border-line bg-surface p-5 text-left shadow-highlight">
        <p className="text-sm font-medium">You'll need</p>
        <ul className="mt-3 flex flex-col gap-2.5 text-sm text-fg-muted">
          <Need icon={Usb}>
            <span className="text-fg">Two YubiKeys</span> with FIDO2: one for every day, one as your backup
          </Need>
          <Need icon={KeyRound}>
            Each key's <span className="text-fg">FIDO2 PIN</span> (or your fingerprint on a YubiKey Bio)
          </Need>
          <Need icon={CircleCheck}>About two minutes</Need>
        </ul>
      </div>
    </StepFrame>
  );
}

function Need({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-text" />
      <span>{children}</span>
    </li>
  );
}

/* ----------------------------------------------------------------------------------- */

const HOW: readonly { icon: LucideIcon; title: string; body: ReactNode }[] = [
  {
    icon: KeyRound,
    title: "Your YubiKey is the key",
    body: "To unlock, plug in your YubiKey, enter its PIN (or use its fingerprint) and touch it. There's no master password.",
  },
  {
    icon: KeySquare,
    title: "Two keys, because there's no other way in",
    body: "Your backup YubiKey is the only recovery. There's no recovery code, and nobody can reset access for you.",
  },
  {
    icon: HardDrive,
    title: "Everything stays on this PC",
    body: (
      <>
        Your vault is one encrypted file in <span className="font-mono text-[13px] text-fg">%LOCALAPPDATA%\efre</span>.
        Copy it yourself to keep a backup.
      </>
    ),
  },
  {
    icon: WifiOff,
    title: "Nothing is sent anywhere",
    body: "efre never connects to the internet: no account, no cloud, no tracking.",
  },
];

export function HowStep({ headingRef, onBack, onNext }: { headingRef: HeadingRef; onBack: () => void; onNext: () => void }) {
  return (
    <StepFrame
      headingRef={headingRef}
      title="How efre works"
      description="A 30-second read before you enroll your keys."
      secondary={
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
      }
      primary={
        <Button variant="primary" size="lg" onClick={onNext}>
          Enroll my first key
          <ArrowRight aria-hidden="true" />
        </Button>
      }
    >
      <ul className="flex flex-col gap-1">
        {HOW.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-4 rounded-lg px-1 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface text-accent-text shadow-highlight">
              <Icon aria-hidden="true" className="size-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-medium text-fg">{title}</p>
              <p className="text-fg-muted text-pretty">{body}</p>
            </div>
          </li>
        ))}
      </ul>
    </StepFrame>
  );
}

/* ----------------------------------------------------------------------------------- */

interface EnrollStepProps {
  headingRef: HeadingRef;
  which: "primary" | "backup";
  defaultNickname: string;
  /** Keys enrolled so far (their names can't be reused). */
  enrolled: readonly KeyInfo[];
  error: KeyErrorCopy | null;
  busy: boolean;
  onEnroll: (nickname: string) => void;
  /** Primary only, before any key is enrolled. */
  onBack?: () => void;
  /** Backup only: opens the "add a backup later" warning. */
  onSkip?: () => void;
  /** Once a key is enrolled. */
  onStartOver?: () => void;
}

export function EnrollStep({
  headingRef,
  which,
  defaultNickname,
  enrolled,
  error,
  busy,
  onEnroll,
  onBack,
  onSkip,
  onStartOver,
}: EnrollStepProps) {
  const [nickname, setNickname] = useState(defaultNickname);
  const [touched, setTouched] = useState(false);
  const taken = enrolled.map((key) => key.nickname);
  const invalid = nicknameError(nickname, taken);
  const primaryName = enrolled[0]?.nickname ?? "your primary key";

  const submit = () => {
    setTouched(true);
    if (invalid === null && !busy) onEnroll(nickname.trim());
  };
  // Enter enrolls from anywhere on the step, not only from the nickname field.
  useEnterKey(submit, !busy);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <StepFrame
        headingRef={headingRef}
        top={
          which === "backup" && enrolled.length > 0 ? (
            <p className="inline-flex items-center gap-1.5 self-start rounded-full bg-success-soft px-2.5 py-0.5 text-[13px] font-medium text-success-text">
              <CircleCheck aria-hidden="true" className="size-3.5" />
              {primaryName} is enrolled
            </p>
          ) : undefined
        }
        title={which === "primary" ? "Enroll your primary key" : "Enroll your backup key"}
        description={
          which === "primary" ? (
            "This is the key you'll use every day."
          ) : (
            <>
              If {primaryName} is ever lost, broken or locked, this key is the{" "}
              <span className="text-fg">only way into your vault</span>.
            </>
          )
        }
        secondary={
          onBack === undefined && onStartOver === undefined ? undefined : (
            <>
              {onBack === undefined ? null : (
                <Button variant="ghost" disabled={busy} onClick={onBack}>
                  <ArrowLeft aria-hidden="true" />
                  Back
                </Button>
              )}
              {onStartOver === undefined ? null : (
                <Button variant="ghost" disabled={busy} onClick={onStartOver}>
                  Start over
                </Button>
              )}
            </>
          )
        }
        primary={
          <>
            {onSkip === undefined ? null : (
              <Button variant="ghost" disabled={busy} onClick={onSkip}>
                Add backup later
              </Button>
            )}
            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {which === "primary" ? "Enroll key" : "Enroll backup key"}
            </Button>
          </>
        }
      >
        <Field
          label="Nickname"
          hint="Shown when efre asks for this key."
          error={touched && invalid !== null ? invalid : undefined}
        >
          {(control) => (
            <Input
              {...control}
              value={nickname}
              maxLength={ITEM_LIMITS.nicknameChars * 2}
              disabled={busy}
              onChange={(event) => {
                setNickname(event.target.value);
              }}
              onBlur={() => {
                setTouched(true);
              }}
            />
          )}
        </Field>

        <ol className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 text-sm shadow-highlight">
          <Instruction n={1}>
            {which === "primary" ? (
              "Plug in the YubiKey you'll use every day."
            ) : (
              <>
                Unplug {primaryName} and plug in your backup key.{" "}
                <span className="text-fg-subtle">One USB port is enough.</span>
              </>
            )}
          </Instruction>
          <Instruction n={2}>
            Choose <span className="text-fg">{which === "primary" ? "Enroll key" : "Enroll backup key"}</span>. Windows asks
            for the key's PIN or fingerprint, then a touch.
          </Instruction>
          <Instruction n={3}>Windows asks once more, to confirm it's the same key. Keep it plugged in.</Instruction>
        </ol>

        {error === null ? null : <KeyErrorAlert copy={error} />}
      </StepFrame>
    </form>
  );
}

function Instruction({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong text-[11px] font-semibold text-fg-subtle"
      >
        {n}
      </span>
      <span className="text-fg-muted">
        <span className="sr-only">Step {n}: </span>
        {children}
      </span>
    </li>
  );
}

/* ----------------------------------------------------------------------------------- */

interface DoneStepProps {
  headingRef: HeadingRef;
  keys: readonly KeyInfo[];
  skippedBackup: boolean;
  error: KeyErrorCopy | null;
  busy: boolean;
  onFinish: () => void;
  /** Back to the backup step (only after "add backup later"). */
  onAddBackup?: () => void;
}

export function DoneStep({ headingRef, keys, skippedBackup, error, busy, onFinish, onAddBackup }: DoneStepProps) {
  const single = keys.length === 1;
  return (
    <StepFrame
      headingRef={headingRef}
      top={
        <span className="mb-1 flex size-10 items-center justify-center rounded-xl bg-success-soft text-success-text">
          <CircleCheck aria-hidden="true" className="size-5" />
        </span>
      }
      title="Your vault is ready"
      description={
        single
          ? `Only ${keys[0]?.nickname ?? "one key"} can open it for now.`
          : `${String(keys.length)} YubiKeys can open it. Either one works on its own.`
      }
      secondary={
        onAddBackup === undefined ? undefined : (
          <Button variant="ghost" disabled={busy} onClick={onAddBackup}>
            <ArrowLeft aria-hidden="true" />
            Enroll a backup now
          </Button>
        )
      }
      primary={
        <Button variant="primary" size="lg" loading={busy} onClick={onFinish}>
          Open my vault
          {busy ? null : <ArrowRight aria-hidden="true" />}
        </Button>
      }
    >
      <ul aria-label="Enrolled keys" className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface shadow-highlight">
        {keys.map((key) => (
          <li key={key.id} className="flex items-center gap-3 px-4 py-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-elevated text-fg-subtle">
              <Usb aria-hidden="true" className="size-4" />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{key.nickname}</span>
            <span className="text-[13px] text-success-text">Enrolled</span>
          </li>
        ))}
      </ul>

      {skippedBackup ? (
        <Alert variant="warning" title="Add a backup key soon">
          If this key is lost or its PIN gets blocked, nothing can open your vault. Add one any time in Settings ›
          YubiKeys; a banner reminds you until you do.
        </Alert>
      ) : null}

      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-fg-muted">
        {single ? null : <li>Keep your backup key somewhere safe, away from the one you carry.</li>}
        <li>To back up your items, copy vault.efre (Settings › Vault file). The copy stays encrypted.</li>
        <li>Lock any time with Ctrl+L. efre also locks when you're away, when the PC sleeps and when you unplug your key.</li>
      </ul>

      {error === null ? null : <KeyErrorAlert copy={error} />}
    </StepFrame>
  );
}
