/**
 * The locked screen (phase "locked"): one Windows Security prompt (key-step
 * "useEnrolledKey") with any enrolled key. Unlock with the button or Enter.
 */
import { CornerDownLeft } from "lucide-react";
import { useState } from "react";

import { useAppStatus, useStatus } from "@/app/app-status";
import { EfreMark } from "@/components/brand/logo";
import { TifinaghName } from "@/components/brand/tifinagh";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ipc } from "@/lib/ipc";

import { KeyIllustration } from "./KeyIllustration";
import { KeyErrorAlert, type KeyErrorCopy, keyErrorCopy } from "./key-errors";
import { KeyPromptOverlay, useKeyPrompt } from "./key-prompt";
import { lockReasonCopy } from "./lock-reason";
import { useEnterKey } from "./use-enter-key";

const listFormat = new Intl.ListFormat("en", { type: "disjunction" });

export function UnlockScreen() {
  const status = useStatus();
  const { setStatus } = useAppStatus();
  const prompt = useKeyPrompt();
  const [error, setError] = useState<KeyErrorCopy | null>(null);
  const nicknames = status.keys.map((key) => key.nickname);

  const unlock = async () => {
    if (prompt.active) return;
    setError(null);
    const result = await prompt.run(() => ipc.unlock());
    if (result.ok) setStatus(result.value);
    else if (!result.cancelledByUser) setError(keyErrorCopy(result.error, "unlock", { keyCount: status.keys.length }));
  };

  useEnterKey(() => {
    void unlock();
  }, !prompt.active);

  const reason = status.lastLockReason === null ? null : lockReasonCopy(status.lastLockReason);

  return (
    <main className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="flex w-full max-w-sm flex-col items-center text-center">
          <KeyIllustration className="w-56 sm:w-64" />

          <h1 className="mt-6 text-xl font-semibold tracking-tight text-balance">Insert and touch your YubiKey</h1>
          <p className="mt-2 text-fg-muted text-pretty">
            {nicknames.length === 0 ? null : (
              <>
                Use <KeyNames names={nicknames} />.{" "}
              </>
            )}
            Windows will ask for its PIN or fingerprint, then a touch.
          </p>

          {reason === null ? null : (
            <p className="mt-5 inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-fg-muted">
              <reason.icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
              <span className="min-w-0">{reason.text}</span>
            </p>
          )}

          {error === null ? null : <KeyErrorAlert copy={error} className="mt-6 w-full text-left" />}

          <Button
            variant="primary"
            size="lg"
            className="mt-8 w-full max-w-64"
            aria-keyshortcuts="Enter"
            disabled={prompt.active}
            onClick={() => {
              void unlock();
            }}
          >
            Unlock
            <Kbd aria-hidden="true" className="border-accent-fg/25 bg-accent-fg/10 text-accent-fg shadow-none">
              <CornerDownLeft className="size-3" />
            </Kbd>
          </Button>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-center gap-2 pb-6 text-[13px] text-fg-subtle">
        <EfreMark className="size-4" />
        <TifinaghName className="text-fg-muted" />
        <span aria-hidden="true">·</span>
        <span>efre keeps everything on this PC.</span>
      </footer>

      <KeyPromptOverlay prompt={prompt} enrolledKeys={nicknames} />
    </main>
  );
}

/** "Primary or Backup", with each nickname emphasised. */
function KeyNames({ names }: { names: readonly string[] }) {
  const parts = listFormat.formatToParts(names);
  return (
    <>
      {parts.map((part, index) =>
        part.type === "element" ? (
          <span key={index} className="font-medium text-fg">
            {part.value}
          </span>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}
