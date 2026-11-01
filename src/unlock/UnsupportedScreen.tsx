/**
 * Phase "unsupported": efre can't run here. Mostly that means Windows lacks the WebAuthn
 * features efre needs (SPEC §3: a clear "update Windows" screen), but the backend also
 * reports other blocking problems here, such as a vault file it can't open.
 */
import { Check, FolderOpen, HardDrive, Monitor, RotateCw, Usb } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useAppStatus, useStatus } from "@/app/app-status";
import { toastError } from "@/app/toast-error";
import { EfreMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import type { AppStatus } from "@/lib/ipc-types";

/** The oldest WebAuthn API with per-credential hmac-secret salts (ARCHITECTURE §4.4). */
const MIN_API_VERSION = 4;

type Problem = "windows" | "vault" | "other";

const WINDOWS_HINTS = /too old|update windows|windows update|latest windows updates|webauthn|hmac-secret|api version|version 4/i;

/** `unsupportedReason` is free text, so this only picks the right headline and advice. */
export function classifyUnsupported(status: Pick<AppStatus, "apiVersion" | "unsupportedReason">): Problem {
  const reason = status.unsupportedReason ?? "";
  if (reason.trim() === "" || WINDOWS_HINTS.test(reason)) return "windows";
  if (status.apiVersion !== null && status.apiVersion < MIN_API_VERSION) return "windows";
  if (/vault/i.test(reason)) return "vault";
  return "other";
}

const HEADINGS: Record<Problem, string> = {
  windows: "Update Windows to use efre",
  vault: "efre can't open your vault",
  other: "efre can't start",
};

export function UnsupportedScreen() {
  const status = useStatus();
  const { refreshStatus } = useAppStatus();
  const [checking, setChecking] = useState(false);
  const problem = classifyUnsupported(status);
  const reason =
    status.unsupportedReason ??
    "This version of Windows can't use a YubiKey the way efre needs. Install the latest Windows updates, then restart efre.";

  const checkAgain = () => {
    setChecking(true);
    void refreshStatus().finally(() => {
      setChecking(false);
    });
  };

  return (
    <main className="flex h-full flex-col overflow-y-auto">
      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="flex w-full max-w-lg flex-col gap-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <EfreMark className="size-12" />
            <div className="flex flex-col gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-balance">{HEADINGS[problem]}</h1>
              <p className="text-fg-muted text-pretty">{reason}</p>
            </div>
          </div>

          {problem === "windows" ? <WindowsNeeds apiVersion={status.apiVersion} /> : null}
          {problem === "vault" ? <VaultAdvice vaultPath={status.vaultPath} /> : null}
          {problem === "other" ? (
            <p className="text-center text-[13px] text-fg-subtle">
              Your vault is safe: efre never changes it when it can't start. Restart efre if this keeps happening.
            </p>
          ) : null}

          <div className="flex flex-col items-center justify-center gap-2 sm:flex-row">
            <Button loading={checking} onClick={checkAgain}>
              {checking ? null : <RotateCw aria-hidden="true" />}
              Check again
            </Button>
            {problem === "vault" ? (
              <Button
                variant="ghost"
                onClick={() => {
                  ipc.openVaultFolder().catch((err: unknown) => toastError(err, "Couldn't open the vault folder"));
                }}
              >
                <FolderOpen aria-hidden="true" />
                Open vault folder
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}

function WindowsNeeds({ apiVersion }: { apiVersion: number | null }) {
  const thisPc =
    apiVersion === null
      ? "Not available on this PC"
      : `This PC has version ${String(apiVersion)}${apiVersion < MIN_API_VERSION ? "" : ", but it couldn't be used"}`;
  return (
    <section aria-labelledby="needs-heading" className="rounded-xl border border-line bg-surface p-5 shadow-highlight">
      <h2 id="needs-heading" className="text-sm font-semibold">
        What efre needs
      </h2>
      <ul className="mt-3 flex flex-col gap-3">
        <Need icon={<Monitor aria-hidden="true" className="size-4" />} title="Windows 10 or 11, fully updated">
          Open Settings › Windows Update, install every update, restart your PC, then open efre again.
        </Need>
        <Need
          icon={<Check aria-hidden="true" className="size-4" />}
          title={`Windows security key API (WebAuthn) version ${String(MIN_API_VERSION)} or later`}
        >
          It lets efre ask your YubiKey for its secret (hmac-secret). {thisPc}.
        </Need>
        <Need icon={<Usb aria-hidden="true" className="size-4" />} title="A YubiKey with FIDO2, on USB">
          With a FIDO2 PIN (or fingerprint on a YubiKey Bio). efre never needs admin rights.
        </Need>
      </ul>
    </section>
  );
}

function VaultAdvice({ vaultPath }: { vaultPath: string }) {
  return (
    <section aria-labelledby="vault-heading" className="rounded-xl border border-line bg-surface p-5 shadow-highlight">
      <h2 id="vault-heading" className="flex items-center gap-2 text-sm font-semibold">
        <HardDrive aria-hidden="true" className="size-4 text-fg-subtle" />
        Your vault file
      </h2>
      {vaultPath === "" ? null : <p className="mt-2 font-mono text-[13px] break-all text-fg-muted">{vaultPath}</p>}
      <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-fg-muted">
        <li>efre never changes or replaces a vault it can't open.</li>
        <li>If another program has the file open (a backup or sync tool), close it, then check again.</li>
        <li>If the file was damaged or changed outside efre, put back a copy you trust.</li>
      </ul>
    </section>
  );
}

function Need({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-elevated text-fg-subtle">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium text-fg">{title}</p>
        <p className="text-[13px] text-fg-muted">{children}</p>
      </div>
    </li>
  );
}
