import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface SkipBackupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The primary key's nickname. */
  primaryName: string;
  onConfirm: () => void;
}

/**
 * SPEC §1: "Add backup later" is allowed only after an explicit warning, which the user
 * must acknowledge (the checkbox) before they can continue with one key.
 */
export function SkipBackupDialog({ open, onOpenChange, primaryName, onConfirm }: SkipBackupDialogProps) {
  const [understood, setUnderstood] = useState(false);
  const checkboxId = useId();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setUnderstood(false);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <span className="mb-1 flex size-9 items-center justify-center rounded-lg bg-warning-soft text-warning-text">
            <TriangleAlert aria-hidden="true" className="size-4" />
          </span>
          <AlertDialogTitle>Continue with only one key?</AlertDialogTitle>
          <AlertDialogDescription>
            A backup YubiKey is the only way back into your vault if {primaryName} is lost, broken or its PIN gets
            blocked. efre has no password and no recovery code, so without a backup your items would be gone for good.
          </AlertDialogDescription>
          <p className="text-sm text-fg-muted">
            You can add a backup later in Settings › YubiKeys. Until you do, a banner reminds you.
          </p>
          <div className="mt-2 flex items-start gap-3 rounded-lg border border-warning-text/25 bg-warning-soft px-3 py-3">
            <Checkbox
              id={checkboxId}
              className="mt-0.5"
              checked={understood}
              onCheckedChange={(checked) => {
                setUnderstood(checked === true);
              }}
            />
            <Label htmlFor={checkboxId} className="text-sm leading-5 font-normal text-fg">
              I understand that if I lose {primaryName}, nothing can open my vault.
            </Label>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Enroll a backup now</AlertDialogCancel>
          <AlertDialogAction
            disabled={!understood}
            onClick={(event) => {
              if (!understood) {
                event.preventDefault();
                return;
              }
              setUnderstood(false);
              onConfirm();
            }}
          >
            Continue with one key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
