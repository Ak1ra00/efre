/**
 * PLACEHOLDER (E0). Owned by E3: replace freely, keep this path and export name.
 * Shown when phase === "unsupported" (Windows lacks the WebAuthn features efre needs).
 */
import { EfreMark } from "@/components/brand/logo";
import { useStatus } from "@/app/app-status";

export function UnsupportedScreen() {
  const status = useStatus();
  return (
    <main className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <EfreMark className="size-12" />
        <h1 className="text-xl font-semibold tracking-tight">Update Windows to use efre</h1>
        <p className="text-fg-muted">
          {status.unsupportedReason ?? "This version of Windows can't use a YubiKey the way efre needs."}
        </p>
      </div>
    </main>
  );
}
