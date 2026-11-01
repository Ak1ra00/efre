import { toast, type ToastHandle } from "@/components/ui/use-toast";
import { friendlyError } from "@/lib/ipc";

/** Shows any command error as a red toast with friendly copy (docs/IPC.md codes). */
export function toastError(err: unknown, title?: string): ToastHandle {
  const copy = friendlyError(err);
  return toast({ variant: "danger", title: title ?? copy.title, description: copy.description });
}
