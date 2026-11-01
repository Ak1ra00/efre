import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useStatus } from "./app-status";
import { useUIState } from "./ui-state";

/**
 * SPEC §1: with only one enrolled key, a persistent banner stays until a second key is
 * enrolled. It disappears on its own once `status.singleKeyWarning` turns false (key
 * management calls refreshStatus() after adding a key).
 */
export function SingleKeyBanner() {
  const status = useStatus();
  const { openSettings } = useUIState();
  if (!status.singleKeyWarning) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-warning-text/20 bg-warning-soft px-4 py-2 text-[13px]"
    >
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning-text" />
      <p className="min-w-0 flex-1 text-fg">
        <span className="font-medium">Only one YubiKey can open this vault.</span>{" "}
        <span className="text-fg-muted">If it's lost, nothing can open the vault. Add a backup key.</span>
      </p>
      <Button
        size="sm"
        onClick={() => {
          openSettings("keys");
        }}
      >
        Add backup key
      </Button>
    </div>
  );
}
