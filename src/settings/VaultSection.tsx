/** Settings › Vault file: where the vault lives and how to back it up yourself. */
import { FolderOpen } from "lucide-react";
import { useState } from "react";

import { useStatus } from "@/app/app-status";
import { toastError } from "@/app/toast-error";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ipc } from "@/lib/ipc";

import { SectionHeader, SettingsGroup } from "./section";

export function VaultSection() {
  const status = useStatus();
  const [opening, setOpening] = useState(false);

  const openFolder = async () => {
    setOpening(true);
    try {
      await ipc.openVaultFolder();
    } catch (err: unknown) {
      toastError(err, "Couldn't open the vault folder");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Vault file"
        description="Your vault is a single encrypted file on this PC. efre never uploads or syncs it."
      />

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-highlight">
        <Field label="Location">
          {(control) => (
            <Input
              {...control}
              readOnly
              value={status.vaultPath}
              className="font-mono text-[13px]"
              onFocus={(event) => {
                event.currentTarget.select();
              }}
            />
          )}
        </Field>
        <div>
          <Button
            loading={opening}
            onClick={() => {
              void openFolder();
            }}
          >
            {opening ? null : <FolderOpen aria-hidden="true" />}
            Open vault folder
          </Button>
        </div>
      </div>

      <SettingsGroup title="Back up your vault">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-fg-muted marker:text-fg-subtle">
          <li>
            Open the vault folder and copy <span className="font-mono text-[13px] text-fg">vault.efre</span> to a USB drive
            or another disk.
          </li>
          <li>The copy stays encrypted: only your enrolled YubiKeys can open it.</li>
          <li>
            After you add or remove a key, make a fresh copy and delete the old ones. A removed key still opens copies
            made before it was removed.
          </li>
        </ol>
        <p className="text-[13px] text-fg-subtle">
          efre writes every change to vault.efre straight away, so a copy made while efre is idle or locked is complete. To
          restore one, quit efre, put the copy in this folder as vault.efre, then start efre.
        </p>
      </SettingsGroup>
    </div>
  );
}
