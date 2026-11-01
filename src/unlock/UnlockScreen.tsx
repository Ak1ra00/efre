/**
 * PLACEHOLDER (E0). Owned by E3: replace freely, keep this path and export name.
 * Shown when phase === "locked". One Windows Security prompt (key-step "useEnrolledKey").
 */
import { useState } from "react";

import { useAppStatus, useStatus } from "@/app/app-status";
import { EfreMark } from "@/components/brand/logo";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { type FriendlyError, friendlyError, ipc } from "@/lib/ipc";

export function UnlockScreen() {
  const status = useStatus();
  const { setStatus } = useAppStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await ipc.unlock());
    } catch (err: unknown) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <EfreMark className="size-14" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Insert and touch your YubiKey</h1>
          <p className="text-fg-muted">
            {status.keys.length === 1 ? "1 key can open this vault." : `${String(status.keys.length)} keys can open this vault.`}
          </p>
        </div>
        {error === null ? null : (
          <Alert role="alert" variant="danger" title={error.title} className="w-full text-left">
            {error.description}
          </Alert>
        )}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          loading={busy}
          onClick={() => {
            void unlock();
          }}
        >
          {busy ? "Waiting for your YubiKey…" : "Unlock"}
        </Button>
      </div>
    </main>
  );
}
