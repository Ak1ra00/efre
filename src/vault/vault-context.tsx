/**
 * Vault screen state and actions, shared by the sidebar, list, detail and editor.
 * Everything here is React state inside <VaultScreen>: it unmounts on lock, which drops
 * all decrypted metadata at once (docs/FRONTEND.md). Nothing is persisted.
 */
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { useAppStatus } from "@/app/app-status";
import { toast, type ToastHandle } from "@/components/ui/use-toast";
import { ipc, ipcErrorCode } from "@/lib/ipc";
import type { ItemKind, ItemMeta } from "@/lib/ipc-types";

import { reportError } from "./errors";
import { type SearchHit, type SortKey, type VaultView, type ViewCounts, viewCounts, visibleItems } from "./search";
import { type LayoutMode, useLayoutMode } from "./use-layout";
import { type EditorTarget, initialVaultState, type VaultState, vaultReducer } from "./vault-reducer";

export type Confirmation =
  | { type: "discard"; then: () => void }
  | { type: "delete"; item: ItemMeta }
  | { type: "emptyTrash"; count: number };

/** "search-end" puts the caret after the text instead of selecting it (type-to-search). */
type FocusTarget = "search" | "search-end" | "list" | "detail" | "editor";

export interface VaultActions {
  reload: () => Promise<void>;
  setView: (view: VaultView) => void;
  setQuery: (query: string) => void;
  setSort: (sort: SortKey) => void;
  /** Selects an item (narrow layout: `open` also shows its detail). */
  select: (id: string | null, options?: { open?: boolean }) => void;
  move: (to: "next" | "previous" | "first" | "last", by?: number) => void;
  /** Enter: show the selected item (narrow) or move focus into its detail. */
  openSelected: () => void;
  /** Esc: leave the editor, go back to the list. Returns false if there was nothing to do. */
  back: () => boolean;
  /** Ctrl+F: focus the search field (its text selected unless `selectAll` is false). */
  focusSearch: (options?: { selectAll?: boolean }) => void;
  focusList: () => void;
  /** Focus the open editor's first field (after a menu that opened it has closed). */
  focusEditor: () => void;
  startCreate: (kind: ItemKind) => void;
  startEdit: (id: string) => void;
  /** Cancel (asks first if there are unsaved changes). */
  cancelEditor: () => void;
  /** After a successful save. */
  editorSaved: (meta: ItemMeta) => void;
  setEditorDirty: (dirty: boolean) => void;
  toggleFavorite: (item: ItemMeta) => Promise<void>;
  trash: (item: ItemMeta) => Promise<void>;
  restore: (item: ItemMeta) => Promise<void>;
  requestDelete: (item: ItemMeta) => void;
  requestEmptyTrash: () => void;
  /** After the confirmation. */
  deletePermanently: (item: ItemMeta) => Promise<void>;
  /** After the confirmation. */
  emptyTrash: () => Promise<void>;
  /** Ctrl+N: the kind choice (leaving an editor with unsaved changes asks first). */
  openNewMenu: () => void;
  copyRole: (item: ItemMeta, role: "password" | "username") => Promise<void>;
  /** Copies one field in Rust. Resolves true on success. */
  copyField: (itemId: string, field: { id: number; label: string }) => Promise<boolean>;
  setSidebarExpanded: (expanded: boolean) => void;
  setNewMenuOpen: (open: boolean) => void;
  confirm: (confirmation: Confirmation | null) => void;
  report: (err: unknown, title?: string) => void;
}

export interface VaultContextValue {
  state: VaultState;
  hits: readonly SearchHit[];
  counts: ViewCounts;
  selected: ItemMeta | null;
  layout: LayoutMode;
  sidebarExpanded: boolean;
  newMenuOpen: boolean;
  confirmation: Confirmation | null;
  searchRef: RefObject<HTMLInputElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  /** Callback ref for the root of whatever the detail pane shows (detail, editor, empty). */
  setDetailElement: (element: HTMLElement | null) => void;
  actions: VaultActions;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const value = use(VaultContext);
  if (value === null) throw new Error("useVault must be used inside <VaultProvider>");
  return value;
}

function roleLabel(role: "password" | "username"): string {
  return role === "password" ? "Password" : "Username";
}

export function copiedTitle(label: string, clearsInSeconds: number): string {
  return `${label} copied — clears in ${String(clearsInSeconds)} s`;
}

interface Latest {
  state: VaultState;
  layout: LayoutMode;
  counts: ViewCounts;
}

/** A focus request older than this is dropped (its target never appeared). */
const FOCUS_REQUEST_MS = 600;

function focusElement(target: FocusTarget, element: HTMLElement) {
  element.focus({ preventScroll: target !== "detail" });
  if (!(element instanceof HTMLInputElement)) return;
  if (target === "search") element.select();
  if (target === "search-end") element.setSelectionRange(element.value.length, element.value.length);
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { refreshStatus } = useAppStatus();
  const [state, dispatch] = useReducer(vaultReducer, initialVaultState);
  const layout = useLayoutMode();
  const [sidebarPreference, setSidebarPreference] = useState<boolean | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const [setDetailElement] = useState(() => (element: HTMLElement | null) => {
    detailRef.current = element;
  });
  const editorDirty = useRef(false);
  const pendingFocus = useRef<{ target: FocusTarget; at: number } | null>(null);
  /** Open "Moved to trash" toasts by item id: their Undo is void once the item is gone. */
  const undoToasts = useRef(new Map<string, ToastHandle>());

  const hits = useMemo(
    () => visibleItems(state.prepared, state.view, state.query, state.sort),
    [state.prepared, state.view, state.query, state.sort],
  );
  const counts = useMemo(() => viewCounts(state.items ?? []), [state.items]);
  const selected = useMemo(
    () => (state.selectedId === null ? null : (state.items?.find((item) => item.id === state.selectedId) ?? null)),
    [state.items, state.selectedId],
  );
  const sidebarExpanded = layout !== "narrow" && (sidebarPreference ?? layout === "wide");

  // Read by the actions below (they are created once and must see the current state).
  const latest = useRef<Latest>({ state, layout, counts });
  useLayoutEffect(() => {
    latest.current = { state, layout, counts };
  });

  // Moves focus once the element it targets has rendered (e.g. the list after "back").
  useLayoutEffect(() => {
    flushFocus();
  });

  function elementFor(target: FocusTarget): HTMLElement | null {
    if (target === "search" || target === "search-end") return searchRef.current;
    if (target === "list") return listRef.current;
    return detailRef.current;
  }

  function flushFocus() {
    const request = pendingFocus.current;
    if (request === null) return;
    if (performance.now() - request.at > FOCUS_REQUEST_MS) {
      pendingFocus.current = null;
      return;
    }
    let element = elementFor(request.target);
    // The editor's first field; while an item is still loading for editing, keep waiting.
    if (request.target === "editor") element = element?.querySelector<HTMLElement>("[data-initial-focus]") ?? null;
    if (element === null) return;
    pendingFocus.current = null;
    focusElement(request.target, element);
  }

  const [actions] = useState<VaultActions>(() => {
    const report = (err: unknown, title?: string) => {
      reportError(err, title, () => {
        void refreshStatus();
      });
    };

    const focusSoon = (target: FocusTarget) => {
      pendingFocus.current = { target, at: performance.now() };
      // If nothing re-renders (the target is already there), focus right away.
      queueMicrotask(flushFocus);
    };

    /** Runs `action` now, or after the user agrees to discard unsaved edits. */
    const guard = (action: () => void) => {
      if (latest.current.state.editor !== null && editorDirty.current) {
        setConfirmation({
          type: "discard",
          then: () => {
            editorDirty.current = false;
            action();
          },
        });
        return;
      }
      editorDirty.current = false;
      action();
    };

    const reload = async () => {
      try {
        dispatch({ type: "loaded", items: await ipc.listItems() });
      } catch (err: unknown) {
        dispatch({ type: "loadFailed" });
        report(err, "Couldn't load your items");
      }
    };

    const actions: VaultActions = {
      reload,
      setView: (view) => {
        guard(() => {
          dispatch({ type: "view", view });
        });
      },
      setQuery: (query) => {
        dispatch({ type: "query", query });
      },
      setSort: (sort) => {
        dispatch({ type: "sort", sort });
      },
      select: (id, options) => {
        const { state: current } = latest.current;
        if (current.editor !== null && !(current.editor.mode === "edit" && current.editor.id === id)) {
          guard(() => {
            dispatch({ type: "select", id, ...(options?.open === undefined ? {} : { open: options.open }) });
          });
          return;
        }
        if (current.editor !== null) return; // already editing this item
        dispatch({ type: "select", id, ...(options?.open === undefined ? {} : { open: options.open }) });
      },
      move: (to, by) => {
        const { state: current } = latest.current;
        if (current.editor !== null) {
          guard(() => {
            dispatch({ type: "closeEditor" });
            dispatch({ type: "move", to, ...(by === undefined ? {} : { by }) });
          });
          return;
        }
        dispatch({ type: "move", to, ...(by === undefined ? {} : { by }) });
      },
      openSelected: () => {
        const { state: current, layout: mode } = latest.current;
        if (current.selectedId === null) return;
        if (mode === "narrow") dispatch({ type: "openDetail" });
        focusSoon("detail");
      },
      back: () => {
        const { state: current, layout: mode } = latest.current;
        if (current.editor !== null) {
          actions.cancelEditor();
          return true;
        }
        if (mode === "narrow" && current.detailOpen) {
          dispatch({ type: "closeDetail" });
          focusSoon("list");
          return true;
        }
        const active = document.activeElement;
        if (active !== null && detailRef.current?.contains(active) === true) {
          focusSoon("list");
          return true;
        }
        return false;
      },
      focusSearch: (options) => {
        const target = options?.selectAll === false ? "search-end" : "search";
        const { state: current, layout: mode } = latest.current;
        if (mode === "narrow" && (current.detailOpen || current.editor !== null)) {
          guard(() => {
            dispatch({ type: "closeDetail" });
            focusSoon(target);
          });
          return;
        }
        focusSoon(target);
      },
      focusEditor: () => {
        focusSoon("editor");
      },
      focusList: () => {
        focusSoon("list");
      },
      startCreate: (kind) => {
        guard(() => {
          dispatch({ type: "edit", target: { mode: "create", kind } });
          focusSoon("editor");
        });
      },
      startEdit: (id) => {
        const target: EditorTarget = { mode: "edit", id };
        const { state: current } = latest.current;
        if (current.editor?.mode === "edit" && current.editor.id === id) return;
        guard(() => {
          dispatch({ type: "edit", target });
          focusSoon("editor");
        });
      },
      cancelEditor: () => {
        guard(() => {
          const wasEditing = latest.current.state.editor?.mode === "edit";
          dispatch({ type: "closeEditor" });
          focusSoon(wasEditing ? "detail" : "list");
        });
      },
      editorSaved: (meta) => {
        editorDirty.current = false;
        dispatch({ type: "saved", meta });
        focusSoon("detail");
      },
      setEditorDirty: (dirty) => {
        editorDirty.current = dirty;
      },
      toggleFavorite: async (item) => {
        try {
          dispatch({ type: "upsert", meta: await ipc.setFavorite(item.id, !item.favorite) });
        } catch (err: unknown) {
          report(err, item.favorite ? "Couldn't remove the favorite" : "Couldn't add to favorites");
        }
      },
      trash: async (item) => {
        try {
          dispatch({ type: "trashed", meta: await ipc.trashItem(item.id) });
        } catch (err: unknown) {
          report(err, "Couldn't move the item to the trash");
          return;
        }
        undoToasts.current.get(item.id)?.dismiss();
        const handle = toast({
          title: "Moved to trash",
          description: `“${item.title}”`,
          action: {
            label: "Undo",
            altText: "Undo: restore the item from the Trash",
            onClick: () => {
              undoToasts.current.delete(item.id);
              ipc.restoreItem(item.id).then(
                (meta) => {
                  dispatch({ type: "restored", meta, select: true });
                },
                (err: unknown) => {
                  report(err, "Couldn't restore the item");
                },
              );
            },
          },
        });
        undoToasts.current.set(item.id, handle);
      },
      restore: async (item) => {
        try {
          dispatch({ type: "restored", meta: await ipc.restoreItem(item.id), select: false });
          undoToasts.current.get(item.id)?.dismiss();
          undoToasts.current.delete(item.id);
          toast({ variant: "success", title: "Restored", description: `“${item.title}” is back in your vault.` });
        } catch (err: unknown) {
          report(err, "Couldn't restore the item");
        }
      },
      requestDelete: (item) => {
        setConfirmation({ type: "delete", item });
      },
      requestEmptyTrash: () => {
        const count = latest.current.counts.trash;
        if (count > 0) setConfirmation({ type: "emptyTrash", count });
      },
      deletePermanently: async (item) => {
        try {
          await ipc.deleteItem(item.id);
          dispatch({ type: "deleted", id: item.id });
          undoToasts.current.get(item.id)?.dismiss();
          undoToasts.current.delete(item.id);
          toast({ title: "Deleted permanently", description: `“${item.title}”` });
          focusSoon("list");
        } catch (err: unknown) {
          report(err, "Couldn't delete the item");
        }
      },
      emptyTrash: async () => {
        try {
          const deleted = await ipc.emptyTrash();
          dispatch({ type: "trashEmptied" });
          for (const handle of undoToasts.current.values()) handle.dismiss();
          undoToasts.current.clear();
          toast({
            title: "Trash emptied",
            description: `${String(deleted)} ${deleted === 1 ? "item was" : "items were"} deleted for good.`,
          });
          focusSoon("list");
        } catch (err: unknown) {
          report(err, "Couldn't empty the trash");
        }
      },
      openNewMenu: () => {
        if (latest.current.state.editor !== null && editorDirty.current) {
          guard(() => {
            dispatch({ type: "closeEditor" });
            setNewMenuOpen(true);
          });
          return;
        }
        setNewMenuOpen(true);
      },
      copyRole: async (item, role) => {
        if (role === "password" && !item.hasPassword) {
          toast({ title: "No password to copy", description: `“${item.title}” has no password field.` });
          return;
        }
        try {
          const result = await ipc.copyRole(item.id, role);
          toast({ variant: "success", title: copiedTitle(roleLabel(role), result.clearsInSeconds) });
        } catch (err: unknown) {
          if (ipcErrorCode(err) === "notFound") {
            toast({ title: `No ${role} to copy`, description: `“${item.title}” has no ${role} field.` });
          } else {
            report(err, "Couldn't copy");
          }
        }
      },
      copyField: async (itemId, field) => {
        try {
          const result = await ipc.copyField(itemId, field.id);
          toast({ variant: "success", title: copiedTitle(field.label, result.clearsInSeconds) });
          return true;
        } catch (err: unknown) {
          report(err, "Couldn't copy");
          return false;
        }
      },
      setSidebarExpanded: (expanded) => {
        setSidebarPreference(expanded);
      },
      setNewMenuOpen,
      confirm: setConfirmation,
      report,
    };
    return actions;
  });

  const value = useMemo<VaultContextValue>(
    () => ({
      state,
      hits,
      counts,
      selected,
      layout,
      sidebarExpanded,
      newMenuOpen,
      confirmation,
      searchRef,
      listRef,
      setDetailElement,
      actions,
    }),
    [state, hits, counts, selected, layout, sidebarExpanded, newMenuOpen, confirmation, setDetailElement, actions],
  );
  return <VaultContext value={value}>{children}</VaultContext>;
}
