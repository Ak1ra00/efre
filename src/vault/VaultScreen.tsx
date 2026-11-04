/**
 * The unlocked vault (E2): sidebar → virtualized list → detail, with search, sorting,
 * the item editor and the trash. Shown below the single-key banner, filling the window.
 *
 * Layout by window width (use-layout.ts): three panes when wide; the sidebar becomes an
 * icon rail when narrower; one pane at a time (list, then detail with Back/Esc) when
 * narrow. All state lives in <VaultProvider> and disappears when the vault locks.
 */
import { useEffect, useState } from "react";

import { useUIState } from "@/app/ui-state";
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
import { cn } from "@/lib/utils";

import { ItemDetail, NoSelection } from "./ItemDetail";
import { ItemEditor } from "./ItemEditor";
import { ItemList } from "./ItemList";
import { Sidebar } from "./Sidebar";
import { useVaultCommands, useVaultShortcuts } from "./vault-commands";
import { type Confirmation, useVault, VaultProvider } from "./vault-context";

export function VaultScreen() {
  return (
    <VaultProvider>
      <VaultLayout />
      <ConfirmDialog />
    </VaultProvider>
  );
}

function VaultLayout() {
  const { state, layout, actions } = useVault();
  useVaultShortcuts();
  useVaultCommands();

  useEffect(() => {
    void actions.reload();
  }, [actions]);

  const narrow = layout === "narrow";
  const showDetail = !narrow || state.detailOpen || state.editor !== null;
  const showList = !narrow || !showDetail;

  return (
    <div className="flex h-full min-h-0 bg-canvas">
      <Sidebar />
      <main className="flex min-w-0 flex-1">
        {showList ? (
          <div
            className={cn(
              "flex min-h-0 flex-col",
              narrow ? "min-w-0 flex-1" : "w-80 shrink-0 border-r border-line xl:w-[22rem]",
            )}
          >
            <ItemList />
          </div>
        ) : null}
        {showDetail ? (
          <div className="min-h-0 min-w-0 flex-1">
            <DetailPane />
          </div>
        ) : null}
      </main>
    </div>
  );
}

function DetailPane() {
  const { state, selected } = useVault();
  if (state.editor !== null) {
    return <ItemEditor key={`${state.editor.mode}-${String(state.editorSeq)}`} target={state.editor} />;
  }
  if (selected !== null) return <ItemDetail key={`${selected.id}-${String(state.revision)}`} meta={selected} />;
  return <NoSelection />;
}

function confirmationCopy(confirmation: Confirmation) {
  switch (confirmation.type) {
    case "discard":
      return {
        title: "Discard your changes?",
        description: "What you changed in this item hasn't been saved.",
        cancel: "Keep editing",
        action: "Discard",
      };
    case "delete":
      return {
        title: `Delete “${confirmation.item.title}” permanently?`,
        description: "It will be removed from your vault for good. This can't be undone.",
        cancel: "Cancel",
        action: "Delete permanently",
      };
    case "emptyTrash":
      return {
        title: "Empty the trash?",
        description: `${String(confirmation.count)} ${confirmation.count === 1 ? "item" : "items"} will be deleted for good. This can't be undone.`,
        cancel: "Cancel",
        action: "Empty trash",
      };
  }
}

/** Confirmations, for destructive actions only (SPEC §7). Focus starts on Cancel. */
function ConfirmDialog() {
  const { confirmation, actions } = useVault();
  const ui = useUIState();
  // Keep the last text on screen while the dialog animates out.
  const [shown, setShown] = useState(confirmation);
  if (confirmation !== null && confirmation !== shown) setShown(confirmation);
  const display = confirmation ?? shown;
  const [confirmed, setConfirmed] = useState(false);
  if (display === null) return null;
  const copy = confirmationCopy(display);

  return (
    <AlertDialog
      open={confirmation !== null && !ui.overlayOpen}
      onOpenChange={(open) => {
        if (!open) actions.confirm(null);
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          // After confirming, the action decides where focus goes.
          if (confirmed) event.preventDefault();
          setConfirmed(false);
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setConfirmed(true);
              actions.confirm(null);
              if (display.type === "discard") display.then();
              else if (display.type === "delete") void actions.deletePermanently(display.item);
              else void actions.emptyTrash();
            }}
          >
            {copy.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
