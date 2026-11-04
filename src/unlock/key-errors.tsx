/**
 * Friendly copy for what a YubiKey flow can end with (docs/SPEC.md §3, ARCHITECTURE §4.7),
 * tuned to the flow it happened in. Anything not special-cased uses friendlyError.
 */
import { Alert } from "@/components/ui/alert";
import { friendlyError, ipcErrorCode } from "@/lib/ipc";

/** Where the error happened; the same outcome needs different advice in each. */
export type KeyFlow = "unlock" | "enroll" | "add" | "rename" | "remove";

export interface KeyErrorCopy {
  code: string;
  title: string;
  description: string;
  /** Extra guidance under the description. */
  detail?: string;
  /** Warnings are soft outcomes (cancelled, timed out, no key); everything else is danger. */
  tone: "warning" | "danger";
  /** Show the "set a FIDO2 PIN" guide. */
  pinGuide?: boolean;
}

interface Context {
  /** Enrolled keys (unlock: does a backup exist?). */
  keyCount?: number;
}

const SOFT = new Set(["authn.cancelled", "authn.timeout", "authn.noDevice"]);

export function keyErrorCopy(err: unknown, flow: KeyFlow, context: Context = {}): KeyErrorCopy {
  const base = friendlyError(err);
  const code = ipcErrorCode(err) ?? base.code;
  const tone = SOFT.has(code) ? "warning" : "danger";
  const copy = (title: string, description: string, detail?: string): KeyErrorCopy =>
    detail === undefined ? { code, title, description, tone } : { code, title, description, detail, tone };

  switch (code) {
    case "authn.cancelled":
      switch (flow) {
        case "unlock":
          return copy(
            "Unlock cancelled",
            "The Windows Security window was closed. If Windows didn't recognise the key, it isn't enrolled in this vault: try your other key.",
          );
        case "enroll":
          return copy(
            "Enrollment cancelled",
            "The Windows Security window was closed, so this key wasn't enrolled. If Windows didn't recognise the key at the second prompt, keep the same key plugged in for both prompts.",
          );
        case "add":
          return copy(
            "Cancelled: no key was added",
            "If Windows didn't recognise the key, the first prompt needs a key that's already enrolled, and the next two need the new key.",
          );
        case "rename":
          return copy(
            "Cancelled: the name wasn't changed",
            "If Windows didn't recognise the key, use one that's enrolled in this vault.",
          );
        case "remove":
          return copy(
            "Cancelled: nothing was changed",
            "The key is still enrolled. If Windows didn't recognise a key, plug in the one efre asked for.",
          );
      }
      break;
    case "authn.alreadyEnrolled":
      return flow === "enroll"
        ? copy("This key is already enrolled", "Insert your other key, then try again. Swapping keys in the same USB port is fine.")
        : copy("This key is already enrolled", "It already opens this vault. Plug in the key you want to add, then try again.");
    case "authn.pinNotSet":
      return { ...copy("Set a PIN on this key first", "This YubiKey has no FIDO2 PIN yet, and efre needs one."), pinGuide: true };
    case "authn.unsupportedPlatform":
      return copy(
        "Update Windows",
        "This version of Windows can't create the key credential efre needs (hmac-secret). Install the latest Windows updates, restart your PC, then try again.",
      );
    case "authn.attestationRejected":
      return copy(
        "Only YubiKeys are accepted",
        "efre couldn't verify this security key as a genuine YubiKey, so it wasn't enrolled. Use a YubiKey with FIDO2 support.",
      );
    case "authn.pinBlocked":
      switch (flow) {
        case "unlock":
          return (context.keyCount ?? 2) > 1
            ? copy(
                "PIN blocked",
                "This key's PIN is blocked — use your backup key, then remove the blocked one in Settings.",
                "Entered a wrong PIN three times in a row? Unplug the key, plug it back in and try again first.",
              )
            : copy(
                "PIN blocked",
                "This key's PIN is blocked. If you entered a wrong PIN three times in a row, unplug the key, plug it back in and try again.",
              );
        case "enroll":
        case "add":
          return copy("This key's PIN is blocked", "A key with a blocked PIN can't be enrolled. Use a different YubiKey.");
        case "rename":
        case "remove":
          return copy("This key's PIN is blocked", "It can't confirm this change, so nothing was changed. Try another enrolled key.");
      }
      break;
    case "authn.unknownKey":
      return flow === "unlock"
        ? copy("This key isn't enrolled", "This YubiKey can't open this vault. Try your other key.")
        : copy("This key isn't enrolled", "Use a key that's enrolled in this vault.");
  }
  return { code, title: base.title, description: base.description, tone };
}

/** An inline error for a YubiKey flow, announced when it appears. */
export function KeyErrorAlert({ copy, className }: { copy: KeyErrorCopy; className?: string }) {
  return (
    <Alert role="alert" variant={copy.tone} title={copy.title} className={className}>
      <p>{copy.description}</p>
      {copy.detail === undefined ? null : <p className="mt-1">{copy.detail}</p>}
      {copy.pinGuide === true ? <PinSetupGuide /> : null}
    </Alert>
  );
}

/** How to give a YubiKey a FIDO2 PIN (efre never handles the PIN itself). */
export function PinSetupGuide() {
  return (
    <div className="mt-2 flex flex-col gap-2 text-[13px] text-fg-muted">
      <p className="font-medium text-fg">To set a PIN, either:</p>
      <ol className="flex list-decimal flex-col gap-1 pl-5">
        <li>
          Open Windows <span className="text-fg">Settings › Accounts › Sign-in options › Security key</span>, choose{" "}
          <span className="text-fg">Manage</span>, touch the key, then <span className="text-fg">Add</span> a PIN.
        </li>
        <li>
          Or use <span className="text-fg">Yubico Authenticator</span>: open <span className="text-fg">Passkeys</span>{" "}
          and set a PIN.
        </li>
      </ol>
      <p>Then come back and try again. Pick a PIN you'll remember: a YubiKey blocks it after 8 wrong tries.</p>
    </div>
  );
}
