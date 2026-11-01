/**
 * PLACEHOLDER (E0). Owned by E3: replace freely, keep this path and export name.
 * Mounted globally while unlocked; opened by useUIState().requestGenerator(onUse?).
 * With `generatorOnUse`, offer "Use" (hands the value to the caller, e.g. the item
 * editor); "Copy" always copies in Rust (copy_generated), never via JS.
 */
import { useState } from "react";

import { toastError } from "@/app/toast-error";
import { useUIState } from "@/app/ui-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { DEFAULT_PASSWORD_OPTIONS, strengthLabel } from "@/lib/defaults";
import { ipc } from "@/lib/ipc";
import type { Generated } from "@/lib/ipc-types";

export function GeneratorDialog() {
  const { generatorOpen, generatorOnUse, closeGenerator } = useUIState();
  const [generated, setGenerated] = useState<Generated | null>(null);

  const generate = async () => {
    try {
      setGenerated(await ipc.generatePassword({ ...DEFAULT_PASSWORD_OPTIONS }));
    } catch (err: unknown) {
      toastError(err, "Couldn't generate a password");
    }
  };

  return (
    <Dialog
      open={generatorOpen}
      onOpenChange={(open) => {
        if (!open) {
          setGenerated(null);
          closeGenerator();
        }
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Password generator</DialogTitle>
          <DialogDescription>Generated in Rust from the OS random number generator.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <output className="min-h-10 rounded-md border border-line bg-canvas px-3 py-2 font-mono break-all">
            {generated?.value ?? "—"}
          </output>
          {generated === null ? null : (
            <Badge variant="accent">
              {strengthLabel(generated.entropyBits)} · {Math.round(generated.entropyBits)} bits
            </Badge>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            onClick={() => {
              void generate();
            }}
          >
            Generate
          </Button>
          <Button
            disabled={generated === null}
            onClick={() => {
              ipc.copyGenerated().then(
                (result) => toast({ variant: "success", title: "Copied", description: `Clears in ${String(result.clearsInSeconds)} s.` }),
                (err: unknown) => toastError(err),
              );
            }}
          >
            Copy
          </Button>
          {generatorOnUse === null ? null : (
            <Button
              variant="primary"
              disabled={generated === null}
              onClick={() => {
                if (generated === null) return;
                generatorOnUse(generated.value);
                setGenerated(null);
                closeGenerator();
              }}
            >
              Use
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
