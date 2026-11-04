/**
 * The vault's keyboard shortcuts (E2 owns Ctrl+N, Ctrl+F, Ctrl+C, Ctrl+B and Esc) and its
 * Ctrl+K palette commands.
 */
import {
  ArchiveRestore,
  Copy,
  Hash,
  Layers,
  Pencil,
  Plus,
  Search,
  Star,
  StarOff,
  Trash2,
  UserRound,
} from "lucide-react";

import { type Command, useRegisterCommands } from "@/app/commands";
import { useUIState } from "@/app/ui-state";
import { useShortcut } from "@/app/use-shortcut";
import { ITEM_KIND_ORDER, ITEM_KINDS } from "@/lib/items";
import { isEditableTarget } from "@/lib/shortcut";

import { KIND_PLURALS } from "./search";
import { useVault } from "./vault-context";

/** True when the keystroke happens in a text field other than the vault search. */
function inOtherTextField(target: EventTarget | null, search: HTMLInputElement | null): boolean {
  return isEditableTarget(target) && target !== search;
}

/** Ctrl+C means "copy this text" when text is selected (in the search field or on the page). */
function hasTextSelection(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0);
  }
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString() !== "";
}

export function useVaultShortcuts(): void {
  const { state, selected, searchRef, actions } = useVault();
  const ui = useUIState();
  const free = !ui.overlayOpen;
  const browsing = free && state.editor === null && selected !== null;

  useShortcut(
    "Ctrl+N",
    () => {
      actions.openNewMenu();
    },
    { enabled: free, allowInInputs: true },
  );
  useShortcut(
    "Ctrl+F",
    () => {
      actions.focusSearch();
    },
    { enabled: free, allowInInputs: true },
  );
  useShortcut(
    "Ctrl+C",
    (event) => {
      if (selected === null || inOtherTextField(event.target, searchRef.current) || hasTextSelection(event.target)) {
        return; // a normal copy of the selected text
      }
      event.preventDefault();
      void actions.copyRole(selected, "password");
    },
    { enabled: browsing, allowInInputs: true, preventDefault: false },
  );
  useShortcut(
    "Ctrl+B",
    (event) => {
      if (selected === null || inOtherTextField(event.target, searchRef.current)) return;
      event.preventDefault();
      void actions.copyRole(selected, "username");
    },
    { enabled: browsing, allowInInputs: true, preventDefault: false },
  );
  useShortcut(
    "Esc",
    (event) => {
      if (actions.back()) event.preventDefault();
    },
    { enabled: free, allowInInputs: true, preventDefault: false },
  );
}

export function useVaultCommands(): void {
  const { state, counts, selected, actions } = useVault();
  const editing = state.editor !== null;
  const item = editing ? null : selected;
  const trashed = item !== null && item.trashedAt !== null;
  const itemKeywords = item === null ? [] : [item.title];

  const commands: Command[] = [
    // Item: acts on the selected item.
    {
      id: "vault.item.copy-password",
      title: "Copy password",
      group: "Item",
      shortcut: "Ctrl+C",
      icon: Copy,
      keywords: ["clipboard", "secret", ...itemKeywords],
      enabled: item?.hasPassword === true,
      run: () => {
        if (item !== null) void actions.copyRole(item, "password");
      },
    },
    {
      id: "vault.item.copy-username",
      title: "Copy username",
      group: "Item",
      shortcut: "Ctrl+B",
      icon: UserRound,
      keywords: ["clipboard", "login", "user", ...itemKeywords],
      enabled: item !== null && item.username !== null,
      run: () => {
        if (item !== null) void actions.copyRole(item, "username");
      },
    },
    {
      id: "vault.item.edit",
      title: "Edit item",
      group: "Item",
      icon: Pencil,
      keywords: ["change", "modify", ...itemKeywords],
      enabled: item !== null && !trashed,
      run: () => {
        if (item !== null) actions.startEdit(item.id);
      },
    },
    {
      id: "vault.item.favorite",
      title: item?.favorite === true ? "Remove from favorites" : "Add to favorites",
      group: "Item",
      icon: item?.favorite === true ? StarOff : Star,
      keywords: ["favorite", "star", "pin", ...itemKeywords],
      enabled: item !== null && !trashed,
      run: () => {
        if (item !== null) void actions.toggleFavorite(item);
      },
    },
    {
      id: "vault.item.trash",
      title: "Move to trash",
      group: "Item",
      icon: Trash2,
      keywords: ["delete", "remove", ...itemKeywords],
      enabled: item !== null && !trashed,
      run: () => {
        if (item !== null) void actions.trash(item);
      },
    },
    {
      id: "vault.item.restore",
      title: "Restore from trash",
      group: "Item",
      icon: ArchiveRestore,
      keywords: ["undelete", "recover", ...itemKeywords],
      enabled: trashed,
      run: () => {
        if (item !== null) void actions.restore(item);
      },
    },
    {
      id: "vault.item.delete",
      title: "Delete permanently",
      group: "Item",
      icon: Trash2,
      keywords: ["remove", "erase", "forever", ...itemKeywords],
      enabled: trashed,
      run: () => {
        if (item !== null) actions.requestDelete(item);
      },
    },

    // New.
    {
      id: "vault.new",
      title: "New item…",
      group: "New",
      shortcut: "Ctrl+N",
      icon: Plus,
      keywords: ["create", "add"],
      run: actions.openNewMenu,
    },
    ...ITEM_KIND_ORDER.map(
      (kind): Command => ({
        id: `vault.new.${kind}`,
        title: `New ${ITEM_KINDS[kind].noun}`,
        group: "New",
        icon: ITEM_KINDS[kind].icon,
        keywords: ["create", "add", ITEM_KINDS[kind].label],
        run: () => {
          actions.startCreate(kind);
        },
      }),
    ),

    // Go to.
    {
      id: "vault.go.all",
      title: "All items",
      group: "Go to",
      icon: Layers,
      keywords: ["show", "everything", "list"],
      run: () => {
        actions.setView({ type: "all" });
      },
    },
    {
      id: "vault.go.favorites",
      title: "Favorites",
      group: "Go to",
      icon: Star,
      keywords: ["show", "starred"],
      run: () => {
        actions.setView({ type: "favorites" });
      },
    },
    ...ITEM_KIND_ORDER.map(
      (kind): Command => ({
        id: `vault.go.${kind}`,
        title: KIND_PLURALS[kind],
        group: "Go to",
        icon: ITEM_KINDS[kind].icon,
        keywords: ["show", "type", ITEM_KINDS[kind].label],
        run: () => {
          actions.setView({ type: "kind", kind });
        },
      }),
    ),
    ...counts.tags.map(
      ({ tag }): Command => ({
        id: `vault.go.tag.${tag}`,
        title: `Tag: ${tag}`,
        group: "Go to",
        icon: Hash,
        keywords: ["show", "tag", "label"],
        run: () => {
          actions.setView({ type: "tag", tag });
        },
      }),
    ),
    {
      id: "vault.go.trash",
      title: "Trash",
      group: "Go to",
      icon: Trash2,
      keywords: ["show", "deleted", "bin"],
      run: () => {
        actions.setView({ type: "trash" });
      },
    },

    // Vault.
    {
      id: "vault.search",
      title: "Search items",
      group: "Vault",
      shortcut: "Ctrl+F",
      icon: Search,
      keywords: ["find", "filter", "look up"],
      run: () => {
        actions.focusSearch();
      },
    },
    {
      id: "vault.empty-trash",
      title: "Empty trash",
      group: "Vault",
      icon: Trash2,
      keywords: ["delete", "purge", "clear"],
      enabled: counts.trash > 0,
      run: actions.requestEmptyTrash,
    },
  ];
  useRegisterCommands(commands);
}
