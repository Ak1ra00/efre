/**
 * First-run wizard (phase "setup", SPEC §6, ARCHITECTURE §6.1):
 *   welcome → how efre works → enroll primary key → enroll backup key → done.
 *
 * - `setup_start` runs once, right before the first enrollment; `setup_enroll_key` shows
 *   two Windows Security prompts per key; `setup_finish` writes the vault and unlocks it.
 * - "Add backup later" needs an acknowledged warning (SkipBackupDialog).
 * - "Start over" (`setup_cancel`) forgets the keys enrolled so far. Nothing is on disk
 *   before `setup_finish`, and non-discoverable credentials leave nothing on the keys.
 * - A lock (sleep, Windows lock) ends the wizard in Rust; the app then remounts this
 *   screen from scratch, and the welcome step says why.
 */
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { useAppStatus, useStatus } from "@/app/app-status";
import { toastError } from "@/app/toast-error";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ipc } from "@/lib/ipc";
import type { KeyInfo, LockReason } from "@/lib/ipc-types";
import { type KeyErrorCopy, keyErrorCopy } from "@/unlock/key-errors";
import { KeyPromptOverlay, sequentialRows, useKeyPrompt } from "@/unlock/key-prompt";
import { uniqueNickname } from "@/unlock/nickname";
import { useEnterKey } from "@/unlock/use-enter-key";

import { SetupProgress, type StepId } from "./SetupProgress";
import { SkipBackupDialog } from "./SkipBackupDialog";
import { DoneStep, EnrollStep, HowStep, WelcomeStep } from "./steps";

const ENROLL_ROWS = ["Register the key with efre", "Confirm with the same key"] as const;

const INTERRUPTED: Record<LockReason, string> = {
  manual: "efre was locked",
  idle: "efre was idle for too long",
  suspend: "your PC went to sleep",
  session: "Windows was locked, or you switched users",
  unplug: "the YubiKey was unplugged",
};

function initialStep(enrolled: number): StepId {
  if (enrolled >= 2) return "done";
  if (enrolled === 1) return "backup";
  return "welcome";
}

export function SetupWizard() {
  const status = useStatus();
  const { setStatus, refreshStatus } = useAppStatus();
  const prompt = useKeyPrompt();

  const [keys, setKeys] = useState<readonly KeyInfo[]>(() => status.setupKeys);
  const [step, setStep] = useState<StepId>(() => initialStep(status.setupKeys.length));
  const [skippedBackup, setSkippedBackup] = useState(false);
  const [error, setError] = useState<KeyErrorCopy | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [startOverOpen, setStartOverOpen] = useState(false);
  // setup_start has run for this wizard (a resumed wizard with keys has started already).
  const started = useRef(status.setupKeys.length > 0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // A lock ended an earlier run of the wizard (Rust wipes it), so this one starts over.
  const [notice] = useState(() =>
    status.lastLockReason !== null && status.setupKeys.length === 0
      ? `The last setup ended because ${INTERRUPTED[status.lastLockReason]}. Nothing was saved, and nothing was left on your keys.`
      : null,
  );

  // Move focus to each new step's title, so keyboard and screen-reader users land there.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const goTo = (next: StepId) => {
    setError(null);
    setStep(next);
  };

  const resetToPrimary = () => {
    started.current = false;
    setKeys([]);
    setSkippedBackup(false);
    setStep("primary");
  };

  const enroll = async (nickname: string) => {
    setError(null);
    const result = await prompt.run(async () => {
      if (!started.current) {
        setStatus(await ipc.setupStart());
        started.current = true;
      }
      return ipc.setupEnrollKey(nickname);
    });
    if (result.ok) {
      setKeys((previous) => [...previous, result.value]);
      void refreshStatus();
      goTo(step === "primary" ? "backup" : "done");
      return;
    }
    if (!result.cancelledByUser) setError(keyErrorCopy(result.error, "enroll"));
  };

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      // The phase becomes "unlocked": the app swaps this screen for the vault.
      setStatus(await ipc.setupFinish());
    } catch (err: unknown) {
      setFinishing(false);
      const next = await refreshStatus();
      const copy = keyErrorCopy(err, "enroll");
      if (next?.phase === "setup" && next.setupKeys.length === 0) {
        // Rust discards an unfinished setup when it can't create the vault.
        resetToPrimary();
        setError({ ...copy, detail: "Nothing was saved, so setup starts again with your primary key." });
      } else {
        setError(copy);
      }
    }
  };

  const startOver = async () => {
    try {
      setStatus(await ipc.setupCancel());
    } catch (err: unknown) {
      toastError(err, "Couldn't start over");
      return;
    }
    setError(null);
    resetToPrimary();
  };

  const busy = prompt.active || finishing;
  const anyDialogOpen = skipOpen || startOverOpen;

  // Enter continues on the steps without a form (the enroll steps handle it themselves).
  useEnterKey(
    () => {
      if (step === "welcome") goTo("how");
      else if (step === "how") goTo("primary");
      else if (step === "done") void finish();
    },
    !busy && !anyDialogOpen && (step === "welcome" || step === "how" || step === "done"),
  );

  const taken = keys.map((key) => key.nickname);
  const primaryName = keys[0]?.nickname ?? "your primary key";

  return (
    <main className="flex h-full flex-col overflow-y-auto">
      <div className="flex shrink-0 justify-center px-4 pt-6 sm:pt-8">
        <SetupProgress current={step} />
      </div>
      <div className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:px-8">
        <motion.div
          key={step}
          className="w-full max-w-[520px]"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          {step === "welcome" ? (
            <WelcomeStep
              headingRef={headingRef}
              notice={notice}
              onNext={() => {
                goTo("how");
              }}
            />
          ) : null}
          {step === "how" ? (
            <HowStep
              headingRef={headingRef}
              onBack={() => {
                goTo("welcome");
              }}
              onNext={() => {
                goTo("primary");
              }}
            />
          ) : null}
          {step === "primary" || step === "backup" ? (
            <EnrollStep
              key={`${step}-${String(keys.length)}`}
              headingRef={headingRef}
              which={step}
              defaultNickname={defaultNickname(step, keys)}
              enrolled={keys}
              error={error}
              busy={busy}
              onEnroll={(nickname) => {
                void enroll(nickname);
              }}
              {...(step === "primary" && keys.length === 0
                ? {
                    onBack: () => {
                      goTo("how");
                    },
                  }
                : {})}
              {...(step === "backup"
                ? {
                    onSkip: () => {
                      setSkipOpen(true);
                    },
                  }
                : {})}
              {...(keys.length > 0
                ? {
                    onStartOver: () => {
                      setStartOverOpen(true);
                    },
                  }
                : {})}
            />
          ) : null}
          {step === "done" ? (
            <DoneStep
              headingRef={headingRef}
              keys={keys}
              skippedBackup={skippedBackup}
              error={error}
              busy={finishing}
              onFinish={() => {
                void finish();
              }}
              {...(skippedBackup && keys.length === 1
                ? {
                    onAddBackup: () => {
                      setSkippedBackup(false);
                      goTo("backup");
                    },
                  }
                : {})}
            />
          ) : null}
        </motion.div>
      </div>

      <KeyPromptOverlay
        prompt={prompt}
        total={2}
        rows={(seen) => sequentialRows(ENROLL_ROWS, seen.length)}
        note={
          step === "backup"
            ? "Swapping keys in the same USB port is fine: efre doesn't lock during setup."
            : undefined
        }
      />

      <SkipBackupDialog
        open={skipOpen}
        onOpenChange={setSkipOpen}
        primaryName={primaryName}
        onConfirm={() => {
          setSkipOpen(false);
          setSkippedBackup(true);
          goTo("done");
        }}
      />

      <AlertDialog open={startOverOpen} onOpenChange={setStartOverOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start over?</AlertDialogTitle>
            <AlertDialogDescription>
              efre forgets {taken.length === 1 ? `“${taken[0] ?? ""}”` : "the keys enrolled so far"} and you enroll
              your keys again. Nothing has been saved yet, and nothing stays on the keys.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep going</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void startOver();
              }}
            >
              Start over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function defaultNickname(step: StepId, keys: readonly KeyInfo[]): string {
  const taken = keys.map((key) => key.nickname);
  return uniqueNickname(step === "backup" ? "Backup" : "Primary", taken);
}
