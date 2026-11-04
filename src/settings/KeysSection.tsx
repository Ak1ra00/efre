/**
 * Settings › YubiKeys: the enrolled keys, and the add / rename / remove-lost-key flows
 * (ARCHITECTURE §6.3–§6.5). Every change needs fresh Windows Security prompts; the
 * shared KeyPromptOverlay says which key and what Windows asks for. After any change the
 * app status is refreshed, so the single-key banner appears or goes away.
 */
import { Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { useAppStatus, useStatus } from "@/app/app-status";
import { Alert } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";
import { ipc } from "@/lib/ipc";
import type { KeyInfo, KeyStep } from "@/lib/ipc-types";
import { ITEM_LIMITS } from "@/lib/items";
import { cn } from "@/lib/utils";
import { KeyErrorAlert, type KeyErrorCopy, keyErrorCopy } from "@/unlock/key-errors";
import { KeyPromptOverlay, type PromptRow, keyRows, sequentialRows, useKeyPrompt } from "@/unlock/key-prompt";
import { nicknameError, uniqueNickname } from "@/unlock/nickname";
import { SecurityKeyIcon } from "@/unlock/SecurityKeyIcon";

import { SectionHeader } from "./section";

/** Settings' Esc closes the dialog, except inside elements with this attribute (Esc cancels the edit there). */
export const ESC_CANCELS_SELECTOR = "[data-settings-esc]";

const ADD_ROWS = ["Confirm with an enrolled key", "Register the new key", "Confirm with the new key"] as const;

type Flow = { kind: "add" } | { kind: "rename" } | { kind: "remove"; remaining: readonly string[] };

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

export function KeysSection() {
  const status = useStatus();
  const { refreshStatus } = useAppStatus();
  const prompt = useKeyPrompt();
  const [keys, setKeys] = useState<readonly KeyInfo[]>(status.keys);
  const [flow, setFlow] = useState<Flow>({ kind: "add" });
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<KeyErrorCopy | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<KeyErrorCopy | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<KeyInfo | null>(null);
  const [removeError, setRemoveError] = useState<KeyErrorCopy | null>(null);
  const names = keys.map((key) => key.nickname);
  const single = keys.length < 2;
  const removeHintId = useId();

  useEffect(() => {
    let cancelled = false;
    ipc.listKeys().then(
      (list) => {
        if (!cancelled) setKeys(list);
      },
      // The status's list is still right; nothing to tell the user.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const sync = async () => {
    void refreshStatus();
    try {
      setKeys(await ipc.listKeys());
    } catch {
      // Keep the list the command returned.
    }
  };

  const addKey = async (nickname: string) => {
    setAddError(null);
    setFlow({ kind: "add" });
    const result = await prompt.run(() => ipc.addKey(nickname));
    if (result.ok) {
      setKeys((list) => [...list, result.value]);
      setAdding(false);
      toast({ variant: "success", title: `“${result.value.nickname}” added`, description: "It can open your vault now." });
      await sync();
    } else if (!result.cancelledByUser) {
      setAddError(keyErrorCopy(result.error, "add"));
    }
  };

  const renameKey = async (key: KeyInfo, nickname: string) => {
    if (nickname === key.nickname) {
      setRenamingId(null);
      return;
    }
    setRenameError(null);
    setFlow({ kind: "rename" });
    const result = await prompt.run(() => ipc.renameKey(key.id, nickname));
    if (result.ok) {
      setKeys((list) => list.map((k) => (k.id === key.id ? result.value : k)));
      setRenamingId(null);
      toast({ variant: "success", title: "Key renamed", description: `It's now called “${result.value.nickname}”.` });
      await sync();
    } else if (!result.cancelledByUser) {
      setRenameError(keyErrorCopy(result.error, "rename"));
    }
  };

  const removeKey = async (key: KeyInfo) => {
    setRemoveError(null);
    const remaining = keys.filter((k) => k.id !== key.id).map((k) => k.nickname);
    setFlow({ kind: "remove", remaining });
    const result = await prompt.run(() => ipc.removeKey(key.id));
    if (result.ok) {
      setKeys(result.value);
      toast({
        variant: "success",
        title: `“${key.nickname}” removed`,
        description: "Your vault was re-encrypted with a new key. Delete old copies of vault.efre and make a fresh one.",
        duration: 10_000,
      });
      await sync();
    } else if (!result.cancelledByUser) {
      setRemoveError({ ...keyErrorCopy(result.error, "remove"), detail: `“${key.nickname}” is still enrolled.` });
    }
  };

  const startAdding = () => {
    setAddError(null);
    setRenamingId(null);
    setAdding(true);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="YubiKeys"
        description="These keys can open your vault. Each one needs its PIN or fingerprint, then a touch."
        action={
          adding ? undefined : (
            <Button disabled={prompt.active} onClick={startAdding}>
              <Plus aria-hidden="true" />
              Add key
            </Button>
          )
        }
      />

      {single && !adding ? (
        <Alert
          variant="warning"
          title="Only one key can open this vault"
          action={
            <Button size="sm" onClick={startAdding}>
              Add backup key
            </Button>
          }
        >
          If it's lost or its PIN gets blocked, nothing can open your vault. Add a backup key.
        </Alert>
      ) : null}

      {removeError === null ? null : <KeyErrorAlert copy={removeError} />}

      <ul aria-label="Enrolled keys" className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface shadow-highlight">
        {keys.map((key) =>
          renamingId === key.id ? (
            <RenameRow
              key={key.id}
              keyInfo={key}
              taken={names.filter((name) => name !== key.nickname)}
              busy={prompt.active}
              error={renameError}
              onSave={(nickname) => {
                void renameKey(key, nickname);
              }}
              onCancel={() => {
                setRenamingId(null);
                setRenameError(null);
              }}
            />
          ) : (
            <li key={key.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <KeyBadge />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{key.nickname}</span>
                <span className="text-[13px] text-fg-subtle" title={dateTimeFormat.format(key.enrolledAt * 1000)}>
                  Enrolled {dateFormat.format(key.enrolledAt * 1000)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Rename ${key.nickname}`}
                  disabled={prompt.active}
                  onClick={() => {
                    setAdding(false);
                    setRenameError(null);
                    setRenamingId(key.id);
                  }}
                >
                  <Pencil aria-hidden="true" />
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${key.nickname}`}
                  aria-describedby={single ? removeHintId : undefined}
                  disabled={single || prompt.active}
                  className="hover:text-danger-text"
                  onClick={() => {
                    setRemoveError(null);
                    setConfirmRemove(key);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              </div>
            </li>
          ),
        )}
      </ul>

      {single ? (
        <p id={removeHintId} className="-mt-3 text-[13px] text-fg-subtle">
          You can remove a key once another one is enrolled: add a backup first.
        </p>
      ) : (
        <p className="-mt-3 text-[13px] text-fg-subtle">
          Lost a key, or its PIN is blocked? Remove it: efre re-encrypts the vault so that key can't open anything saved
          from then on.
        </p>
      )}

      {adding ? (
        <AddKeyPanel
          defaultNickname={uniqueNickname(single ? "Backup" : `Key ${String(keys.length + 1)}`, names)}
          taken={names}
          busy={prompt.active}
          error={addError}
          onAdd={(nickname) => {
            void addKey(nickname);
          }}
          onCancel={() => {
            setAdding(false);
            setAddError(null);
          }}
        />
      ) : null}

      <RemoveKeyDialog
        keyInfo={confirmRemove}
        remaining={confirmRemove === null ? [] : names.filter((_, i) => keys[i]?.id !== confirmRemove.id)}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
        onConfirm={(key) => {
          setConfirmRemove(null);
          void removeKey(key);
        }}
      />

      <KeyPromptOverlay prompt={prompt} enrolledKeys={names} {...overlayProps(flow)} />
    </div>
  );
}

function overlayProps(flow: Flow): {
  total?: number;
  rows?: (seen: readonly KeyStep[]) => readonly PromptRow[];
  note?: ReactNode;
} {
  switch (flow.kind) {
    case "add":
      return {
        total: 3,
        rows: (seen) => sequentialRows(ADD_ROWS, seen.length),
        note: "One USB port is enough: unplug your current key when Windows asks for the new one. efre won't lock while you swap.",
      };
    case "rename":
      return {};
    case "remove":
      return {
        total: flow.remaining.length,
        rows: (seen) => keyRows(flow.remaining, seen),
        note: "Each remaining key confirms once. Nothing changes until every one has, and swapping keys in one USB port is fine.",
      };
  }
}

function KeyBadge() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-elevated text-fg-subtle">
      <SecurityKeyIcon />
    </span>
  );
}

/* ----------------------------------------------------------------------------------- */

interface RenameRowProps {
  keyInfo: KeyInfo;
  taken: readonly string[];
  busy: boolean;
  error: KeyErrorCopy | null;
  onSave: (nickname: string) => void;
  onCancel: () => void;
}

function RenameRow({ keyInfo, taken, busy, error, onSave, onCancel }: RenameRowProps) {
  const [value, setValue] = useState(keyInfo.nickname);
  const invalid = nicknameError(value, taken);
  const [touched, setTouched] = useState(false);
  return (
    <li className="px-4 py-3" data-settings-esc="">
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (invalid === null && !busy) onSave(value.trim());
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <div className="flex items-start gap-3">
          <KeyBadge />
          <Field
            className="min-w-0 flex-1"
            label={`New name for “${keyInfo.nickname}”`}
            hint="Renaming asks for one touch on any enrolled key."
            error={touched && invalid !== null ? invalid : undefined}
          >
            {(control) => (
              <Input
                {...control}
                autoFocus
                value={value}
                maxLength={ITEM_LIMITS.nicknameChars * 2}
                disabled={busy}
                onChange={(event) => {
                  setValue(event.target.value);
                  setTouched(true);
                }}
              />
            )}
          </Field>
        </div>
        {error === null ? null : <KeyErrorAlert copy={error} />}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" type="submit" variant="primary" disabled={busy}>
            Save name
          </Button>
        </div>
      </form>
    </li>
  );
}

/* ----------------------------------------------------------------------------------- */

interface AddKeyPanelProps {
  defaultNickname: string;
  taken: readonly string[];
  busy: boolean;
  error: KeyErrorCopy | null;
  onAdd: (nickname: string) => void;
  onCancel: () => void;
}

function AddKeyPanel({ defaultNickname, taken, busy, error, onAdd, onCancel }: AddKeyPanelProps) {
  const [value, setValue] = useState(defaultNickname);
  const [touched, setTouched] = useState(false);
  const invalid = nicknameError(value, taken);
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-line-strong bg-surface p-5 shadow-highlight"
      data-settings-esc=""
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (invalid === null && !busy) onAdd(value.trim());
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h3 id={titleId} className="text-sm font-semibold">
          Add a YubiKey
        </h3>
        <Field label="Nickname" hint="Shown when efre asks for this key." error={touched && invalid !== null ? invalid : undefined}>
          {(control) => (
            <Input
              {...control}
              autoFocus
              value={value}
              maxLength={ITEM_LIMITS.nicknameChars * 2}
              disabled={busy}
              onChange={(event) => {
                setValue(event.target.value);
                setTouched(true);
              }}
            />
          )}
        </Field>
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-fg-muted">Windows Security asks three times, each for a PIN or fingerprint and a touch:</p>
          <ol className="flex flex-col gap-2 text-[13px]">
            <PromptStep n={1}>With a key that's already enrolled, to prove it's you.</PromptStep>
            <PromptStep n={2}>With the new key, to register it.</PromptStep>
            <PromptStep n={3}>With the new key again, to confirm it.</PromptStep>
          </ol>
          <p className="text-[13px] text-fg-subtle">
            One USB port is enough: unplug your current key when Windows asks for the new one. efre won't lock while you
            swap.
          </p>
        </div>
        {error === null ? null : <KeyErrorAlert copy={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Add key
          </Button>
        </div>
      </form>
    </section>
  );
}

function PromptStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong text-[11px] font-semibold text-fg-subtle"
      >
        {n}
      </span>
      <span className="text-fg-muted">
        <span className="sr-only">Prompt {n}: </span>
        {children}
      </span>
    </li>
  );
}

/* ----------------------------------------------------------------------------------- */

interface RemoveKeyDialogProps {
  /** The key to remove; null = closed. */
  keyInfo: KeyInfo | null;
  /** Nicknames of the keys that stay. */
  remaining: readonly string[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (key: KeyInfo) => void;
}

const andList = new Intl.ListFormat("en", { type: "conjunction" });

/** The destructive confirmation for "remove lost key" (ARCHITECTURE §6.5). */
function RemoveKeyDialog({ keyInfo, remaining, onOpenChange, onConfirm }: RemoveKeyDialogProps) {
  // Keep the last key while the dialog animates out.
  const [shown, setShown] = useState<KeyInfo | null>(keyInfo);
  if (keyInfo !== null && keyInfo !== shown) setShown(keyInfo);
  const name = shown?.nickname ?? "";
  return (
    <AlertDialog open={keyInfo !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <span className="mb-1 flex size-9 items-center justify-center rounded-lg bg-danger-soft text-danger-text">
            <TriangleAlert aria-hidden="true" className="size-4" />
          </span>
          <AlertDialogTitle>Remove “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Use this when a key is lost, broken or its PIN is blocked. efre re-encrypts your whole vault with a new key,
            so “{name}” can't open anything saved from now on.
          </AlertDialogDescription>
          <ul className="mt-1 flex list-disc flex-col gap-1.5 pl-5 text-sm text-fg-muted">
            <li>
              Every remaining key confirms once: <span className="text-fg">{andList.format(remaining)}</span>. Keep them
              at hand.
            </li>
            <li>If you cancel part-way, nothing changes.</li>
          </ul>
          <div className={cn("mt-2 rounded-lg border border-warning-text/25 bg-warning-soft px-3 py-2.5 text-[13px] text-fg")}>
            <p className="font-medium">Old copies still open with this key</p>
            <p className="mt-0.5 text-fg-muted">
              Copies of vault.efre made before now can still be opened with “{name}”. Delete them, then make a fresh copy.
            </p>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (shown !== null) onConfirm(shown);
            }}
          >
            Remove key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
