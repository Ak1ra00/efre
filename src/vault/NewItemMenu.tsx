import { Plus } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KbdCombo } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { ITEM_KIND_ORDER, ITEM_KINDS } from "@/lib/items";
import { cn } from "@/lib/utils";

import { useVault } from "./vault-context";

/**
 * "New item" with the kind choice. Ctrl+N opens it (the menu is controlled by the vault
 * state), so there is exactly one of these on screen: in the sidebar or the icon rail.
 */
export function NewItemMenu({ compact }: { compact: boolean }) {
  const { newMenuOpen, actions } = useVault();
  const chose = useRef(false);

  const trigger = compact ? (
    <Button variant="primary" size="icon" aria-label="New item" aria-keyshortcuts="Control+N">
      <Plus aria-hidden="true" />
    </Button>
  ) : (
    <Button variant="primary" className="w-full justify-start px-2.5" aria-keyshortcuts="Control+N">
      <Plus aria-hidden="true" />
      New item
      <KbdCombo combo="Ctrl+N" className="ml-auto [&_kbd]:border-accent-fg/20 [&_kbd]:bg-accent-fg/10 [&_kbd]:text-accent-fg" />
    </Button>
  );

  return (
    <DropdownMenu open={newMenuOpen} onOpenChange={actions.setNewMenuOpen}>
      {compact ? (
        <Tip label="New item" shortcut="Ctrl+N" side="right">
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </Tip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align="start"
        side={compact ? "right" : "bottom"}
        className={cn(compact ? "min-w-48" : "w-(--radix-dropdown-menu-trigger-width)")}
        onCloseAutoFocus={(event) => {
          // The editor puts focus in its first field; don't pull it back to this button.
          if (chose.current) event.preventDefault();
          chose.current = false;
        }}
        onKeyDown={(event) => {
          // 1–5 pick a kind directly (the hints on the right).
          const kind = /^[1-9]$/.test(event.key) ? ITEM_KIND_ORDER[Number(event.key) - 1] : undefined;
          if (kind === undefined || event.ctrlKey || event.altKey || event.metaKey) return;
          event.preventDefault();
          chose.current = true;
          actions.setNewMenuOpen(false);
          actions.startCreate(kind);
        }}
      >
        <DropdownMenuLabel>New item</DropdownMenuLabel>
        {ITEM_KIND_ORDER.map((kind, index) => {
          const { icon: Icon, label } = ITEM_KINDS[kind];
          return (
            <DropdownMenuItem
              key={kind}
              onSelect={() => {
                chose.current = true;
                actions.startCreate(kind);
              }}
            >
              <Icon aria-hidden="true" />
              {label}
              <DropdownMenuShortcut combo={String(index + 1)} className="[&_kbd]:min-w-5" />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
