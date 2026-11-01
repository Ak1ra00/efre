import { Lock, type LucideIcon, Moon, Timer, Unplug, UserRoundX } from "lucide-react";

import { formatMinutes } from "@/lib/defaults";
import type { LockReason } from "@/lib/ipc-types";

export interface LockReasonCopy {
  icon: LucideIcon;
  text: string;
}

/**
 * Why the vault last locked (AppStatus.lastLockReason), for the unlock screen.
 * `idleMinutes` names the auto-lock time when it is known. AppStatus doesn't carry it in
 * IPC v1, and the webview is reloaded on lock, so the unlock screen passes null today.
 */
export function lockReasonCopy(reason: LockReason, idleMinutes: number | null = null): LockReasonCopy {
  switch (reason) {
    case "manual":
      return { icon: Lock, text: "You locked efre." };
    case "idle":
      return {
        icon: Timer,
        text:
          idleMinutes === null
            ? "Locked after a while without activity (auto-lock)."
            : `Locked after ${formatMinutes(idleMinutes)} without activity.`,
      };
    case "suspend":
      return { icon: Moon, text: "Locked because your PC went to sleep." };
    case "session":
      return { icon: UserRoundX, text: "Locked because Windows was locked, or you switched users or signed out." };
    case "unplug":
      return { icon: Unplug, text: "Locked because no YubiKey was plugged in." };
  }
}
