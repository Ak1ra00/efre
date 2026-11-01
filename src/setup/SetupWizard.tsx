/**
 * PLACEHOLDER (E0). Owned by E3: replace freely, keep this path and export name.
 * Shown when phase === "setup". The real wizard: welcome → how efre works → enroll
 * primary key → enroll backup key (or "add later" after a warning) → done.
 */
import { useState } from "react";

import { useAppStatus, useStatus } from "@/app/app-status";
import { toastError } from "@/app/toast-error";
import { EfreMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";

export function SetupWizard() {
  const status = useStatus();
  const { setStatus, refreshStatus } = useAppStatus();
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err: unknown) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const enrolled = status.setupKeys.length;
  return (
    <main className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-6 text-center">
        <EfreMark className="size-14" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Welcome to efre</h1>
          <p className="text-fg-muted">
            {enrolled === 0
              ? "Your vault opens only with your YubiKeys. Setup is coming in this phase."
              : `${String(enrolled)} key${enrolled === 1 ? "" : "s"} enrolled.`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              void run(async () => {
                if (enrolled === 0) await ipc.setupStart();
                await ipc.setupEnrollKey(enrolled === 0 ? "Primary key" : "Backup key");
                await refreshStatus();
              });
            }}
          >
            Enroll a key
          </Button>
          {enrolled > 0 ? (
            <Button
              disabled={busy}
              onClick={() => {
                void run(async () => {
                  setStatus(await ipc.setupFinish());
                });
              }}
            >
              Finish
            </Button>
          ) : null}
        </div>
      </div>
    </main>
  );
}
