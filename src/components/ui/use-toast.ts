/**
 * In-memory toast store (never persisted). Call `toast()` from anywhere; `<Toaster />`
 * (mounted once by the app shell) renders it. Toasts with an action ("Undo") stay longer.
 */
import { useSyncExternalStore } from "react";

export type ToastVariant = "default" | "success" | "danger";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** How to do the same without the toast, for screen readers. Defaults to `label`. */
  altText?: string;
}

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  action?: ToastAction;
  /** Milliseconds; default 5000, or 8000 with an action. */
  duration?: number;
}

export interface ToastRecord extends ToastOptions {
  id: string;
  open: boolean;
}

export interface ToastHandle {
  id: string;
  dismiss: () => void;
  update: (options: Partial<ToastOptions>) => void;
}

export const TOAST_LIMIT = 3;
/** Long enough for the exit animation. */
const REMOVE_DELAY_MS = 200;

let toasts: readonly ToastRecord[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setToasts(next: readonly ToastRecord[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

function scheduleRemoval(id: string) {
  if (removalTimers.has(id)) return;
  removalTimers.set(
    id,
    setTimeout(() => {
      removalTimers.delete(id);
      setToasts(toasts.filter((t) => t.id !== id));
    }, REMOVE_DELAY_MS),
  );
}

/** Closes one toast (animated), or all of them. */
export function dismissToast(id?: string) {
  const closing = toasts.filter((t) => t.open && (id === undefined || t.id === id));
  if (closing.length === 0) return;
  setToasts(toasts.map((t) => (closing.includes(t) ? { ...t, open: false } : t)));
  for (const t of closing) scheduleRemoval(t.id);
}

export function updateToast(id: string, options: Partial<ToastOptions>) {
  setToasts(toasts.map((t) => (t.id === id ? { ...t, ...options } : t)));
}

/** Removes every toast immediately (on lock). */
export function clearToasts() {
  for (const timer of removalTimers.values()) clearTimeout(timer);
  removalTimers.clear();
  setToasts([]);
}

export function toast(options: ToastOptions): ToastHandle {
  counter += 1;
  const id = `toast-${String(counter)}`;
  const next = [...toasts, { ...options, id, open: true }];
  // Keep at most TOAST_LIMIT open: close the oldest.
  const open = next.filter((t) => t.open);
  const excess = open.slice(0, Math.max(0, open.length - TOAST_LIMIT));
  setToasts(next.map((t) => (excess.includes(t) ? { ...t, open: false } : t)));
  for (const t of excess) scheduleRemoval(t.id);
  return {
    id,
    dismiss: () => {
      dismissToast(id);
    },
    update: (patch) => {
      updateToast(id, patch);
    },
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => toasts;

/** `const { toast } = useToast(); toast({ title: "Moved to trash", action: { label: "Undo", onClick } })`. */
export function useToast() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { toasts: current, toast, dismiss: dismissToast };
}
