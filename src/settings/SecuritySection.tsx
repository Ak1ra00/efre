/** Settings › Security: versions, what protects the vault, and the honest limits (security_info). */
import { CircleCheck, Info, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";

import { TifinaghName } from "@/components/brand/tifinagh";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError, ipc } from "@/lib/ipc";
import type { SecurityInfo } from "@/lib/ipc-types";

import { SectionHeader, SettingsGroup } from "./section";

type Load = { state: "loading" } | { state: "ready"; info: SecurityInfo } | { state: "failed"; message: string };

export function SecuritySection() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    ipc.securityInfo().then(
      (info) => {
        if (!cancelled) setLoad({ state: "ready", info });
      },
      (err: unknown) => {
        if (!cancelled) setLoad({ state: "failed", message: friendlyError(err).description });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="Security" description="What protects your vault, and what efre can't protect against." />
      {load.state === "loading" ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-40" />
        </div>
      ) : null}
      {load.state === "failed" ? (
        <Alert
          role="alert"
          variant="danger"
          title="Couldn't load the security details"
          action={
            <Button
              size="sm"
              onClick={() => {
                setLoad({ state: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          }
        >
          {load.message}
        </Alert>
      ) : null}
      {load.state === "ready" ? <Details info={load.info} /> : null}
    </div>
  );
}

function Details({ info }: { info: SecurityInfo }) {
  const facts: [string, string][] = [
    ["efre", info.appVersion],
    ["Vault format", `v${String(info.formatVersion)}`],
    ["WebAuthn API", info.webauthnApiVersion === null ? "Not available" : `v${String(info.webauthnApiVersion)}`],
    ["Enrolled keys", String(info.keyCount)],
  ];
  return (
    <>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line shadow-highlight sm:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 bg-surface px-4 py-3">
            <dt className="text-[13px] text-fg-subtle">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <SettingsGroup title="Protections">
        <ul className="flex flex-col gap-2.5">
          {info.protections.map((text) => (
            <li key={text} className="flex items-start gap-2.5 text-sm text-fg-muted">
              <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-text" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </SettingsGroup>

      <SettingsGroup title="Honest limits">
        <ul className="flex flex-col gap-2.5">
          {info.limits.map((text) => (
            <li key={text} className="flex items-start gap-2.5 text-sm text-fg-muted">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-text" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </SettingsGroup>

      <p className="text-[13px] text-fg-subtle">
        efre, <TifinaghName className="text-fg-muted" /> (ifri), means “cave” in Tamazight. Open source under
        the MIT License.
      </p>
    </>
  );
}
