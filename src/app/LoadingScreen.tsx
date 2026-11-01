import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import { EfreMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { friendlyError } from "@/lib/ipc";

import { useAppStatus } from "./app-status";

/** Shown until the first app_status arrives. Stays blank for 300 ms to avoid a flash. */
export function LoadingScreen() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  return (
    <main className="flex h-full items-center justify-center" aria-busy="true">
      {visible ? (
        <div className="flex animate-fade-in flex-col items-center gap-4">
          <EfreMark className="size-10" />
          <Spinner size="md" label="Starting efre" className="text-fg-subtle" />
        </div>
      ) : (
        <span className="sr-only">Starting efre</span>
      )}
    </main>
  );
}

/** app_status failed: efre can't tell which screen to show. */
export function StartupError() {
  const { error, refreshStatus } = useAppStatus();
  const [retrying, setRetrying] = useState(false);
  const copy = friendlyError(error);
  return (
    <main className="flex h-full items-center justify-center p-8">
      <div role="alert" className="flex max-w-sm flex-col items-center gap-4 text-center">
        <EfreMark className="size-10" />
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold">efre couldn't start</h1>
          <p className="text-fg-muted">{copy.description}</p>
        </div>
        <Button
          loading={retrying}
          onClick={() => {
            setRetrying(true);
            void refreshStatus().finally(() => {
              setRetrying(false);
            });
          }}
        >
          {retrying ? null : <RotateCw aria-hidden="true" />}
          Try again
        </Button>
      </div>
    </main>
  );
}
