/**
 * The vault screen's state transitions (pure). Decrypted metadata lives here only while
 * the vault is unlocked: the state belongs to <VaultScreen>, which unmounts on lock.
 */
import type { ItemKind, ItemMeta } from "@/lib/ipc-types";

import { inView, prepareItems, type PreparedItem, sameView, type SortKey, type VaultView, visibleItems } from "./search";

export type EditorTarget = { mode: "create"; kind: ItemKind } | { mode: "edit"; id: string };

export interface VaultState {
  /** null until list_items answers. Includes trashed items. */
  items: ItemMeta[] | null;
  prepared: readonly PreparedItem[];
  loadFailed: boolean;
  view: VaultView;
  query: string;
  sort: SortKey;
  selectedId: string | null;
  /** Narrow layout: the detail (or editor) pane replaces the list. */
  detailOpen: boolean;
  editor: EditorTarget | null;
  /** Bumped whenever an editor opens, so each one starts fresh. */
  editorSeq: number;
  /** Bumped after a save so the opened item is fetched again. */
  revision: number;
}

export type VaultEvent =
  | { type: "loaded"; items: ItemMeta[] }
  | { type: "loadFailed" }
  | { type: "upsert"; meta: ItemMeta }
  | { type: "trashed"; meta: ItemMeta }
  | { type: "restored"; meta: ItemMeta; select: boolean }
  | { type: "deleted"; id: string }
  | { type: "trashEmptied" }
  | { type: "view"; view: VaultView }
  | { type: "query"; query: string }
  | { type: "sort"; sort: SortKey }
  | { type: "select"; id: string | null; open?: boolean }
  | { type: "move"; to: "next" | "previous" | "first" | "last"; by?: number }
  | { type: "openDetail" }
  | { type: "closeDetail" }
  | { type: "edit"; target: EditorTarget }
  | { type: "closeEditor" }
  | { type: "saved"; meta: ItemMeta };

export const initialVaultState: VaultState = {
  items: null,
  prepared: [],
  loadFailed: false,
  view: { type: "all" },
  query: "",
  sort: "title",
  selectedId: null,
  detailOpen: false,
  editor: null,
  editorSeq: 0,
  revision: 0,
};

function hitIds(state: VaultState): string[] {
  return visibleItems(state.prepared, state.view, state.query, state.sort).map((hit) => hit.item.id);
}

function withItems(state: VaultState, items: ItemMeta[]): VaultState {
  return { ...state, items, prepared: prepareItems(items), loadFailed: false };
}

function upsertItem(items: readonly ItemMeta[] | null, meta: ItemMeta): ItemMeta[] {
  const list = items ?? [];
  const index = list.findIndex((item) => item.id === meta.id);
  if (index === -1) return [...list, meta];
  const next = [...list];
  next[index] = meta;
  return next;
}

/**
 * After `id` leaves the visible list (trashed, restored, deleted), select its neighbour
 * in the list as it was: the next item, else the previous one.
 */
function selectNeighbour(before: readonly string[], next: VaultState, id: string): VaultState {
  if (next.selectedId !== id) return next;
  const after = new Set(hitIds(next));
  if (after.has(id)) return next;
  const index = before.indexOf(id);
  const candidates = index === -1 ? [] : [...before.slice(index + 1), ...before.slice(0, index).reverse()];
  const neighbour = candidates.find((candidate) => after.has(candidate)) ?? null;
  return { ...next, selectedId: neighbour, detailOpen: false };
}

function move(state: VaultState, to: "next" | "previous" | "first" | "last", by = 1): VaultState {
  const ids = hitIds(state);
  if (ids.length === 0) return state;
  const current = state.selectedId === null ? -1 : ids.indexOf(state.selectedId);
  let index: number;
  if (to === "first") index = 0;
  else if (to === "last") index = ids.length - 1;
  else if (current === -1) index = 0;
  else index = Math.min(ids.length - 1, Math.max(0, current + (to === "next" ? by : -by)));
  const selectedId = ids[index] ?? null;
  return selectedId === state.selectedId ? state : { ...state, selectedId };
}

export function vaultReducer(state: VaultState, event: VaultEvent): VaultState {
  switch (event.type) {
    case "loaded": {
      const next = withItems(state, event.items);
      const selectedStillThere = event.items.some((item) => item.id === state.selectedId);
      return selectedStillThere ? next : { ...next, selectedId: null, detailOpen: false };
    }
    case "loadFailed":
      return { ...state, loadFailed: true };
    case "upsert":
      return withItems(state, upsertItem(state.items, event.meta));
    case "trashed":
    case "deleted": {
      const before = hitIds(state);
      const id = event.type === "trashed" ? event.meta.id : event.id;
      const items =
        event.type === "trashed"
          ? upsertItem(state.items, event.meta)
          : (state.items ?? []).filter((item) => item.id !== event.id);
      const next = withItems(state, items);
      const editor = next.editor?.mode === "edit" && next.editor.id === id ? null : next.editor;
      return selectNeighbour(before, { ...next, editor }, id);
    }
    case "restored": {
      const before = hitIds(state);
      const next = withItems(state, upsertItem(state.items, event.meta));
      if (event.select) {
        // Undo: show the restored item again (in a view that contains it).
        const view = inView(event.meta, next.view) ? next.view : { type: "all" as const };
        return { ...next, view, selectedId: event.meta.id };
      }
      return selectNeighbour(before, next, event.meta.id);
    }
    case "trashEmptied": {
      const items = (state.items ?? []).filter((item) => item.trashedAt === null);
      const next = withItems(state, items);
      const selectedStillThere = items.some((item) => item.id === state.selectedId);
      return selectedStillThere ? next : { ...next, selectedId: null, detailOpen: false };
    }
    case "view": {
      if (sameView(state.view, event.view) && state.editor === null) return { ...state, detailOpen: false };
      const next: VaultState = { ...state, view: event.view, editor: null, detailOpen: false };
      const keep = state.selectedId !== null && hitIds(next).includes(state.selectedId);
      return keep ? next : { ...next, selectedId: null };
    }
    case "query": {
      const next = { ...state, query: event.query };
      // Raycast-style: while typing, the best match is selected (not while editing).
      if (event.query.trim() === "" || state.editor !== null) return next;
      return { ...next, selectedId: hitIds(next)[0] ?? null };
    }
    case "sort":
      return { ...state, sort: event.sort };
    case "select":
      return {
        ...state,
        selectedId: event.id,
        editor: null,
        detailOpen: event.id !== null && (event.open ?? (state.detailOpen && state.editor === null)),
      };
    case "move":
      return move(state, event.to, event.by);
    case "openDetail":
      return state.selectedId === null ? state : { ...state, detailOpen: true };
    case "closeDetail":
      return { ...state, detailOpen: false, editor: null };
    case "edit":
      return {
        ...state,
        editor: event.target,
        editorSeq: state.editorSeq + 1,
        selectedId: event.target.mode === "edit" ? event.target.id : state.selectedId,
        detailOpen: true,
      };
    case "closeEditor":
      return {
        ...state,
        editor: null,
        detailOpen: state.editor?.mode === "edit" ? state.detailOpen : false,
      };
    case "saved": {
      const next = withItems(state, upsertItem(state.items, event.meta));
      const created = state.editor?.mode === "create";
      let result: VaultState = {
        ...next,
        editor: null,
        selectedId: event.meta.id,
        detailOpen: true,
        revision: state.revision + 1,
      };
      if (created && !hitIds(result).includes(event.meta.id)) {
        // Make sure the new item is visible in the list.
        result = { ...result, view: { type: "all" }, query: "" };
      }
      return result;
    }
  }
}
