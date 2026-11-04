import { ArchiveRestore, ArrowLeft, Hash, MousePointerClick, Pencil, RotateCw, Star, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { KbdCombo } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { friendlyError, ipc, ipcErrorCode } from "@/lib/ipc";
import type { FieldView, ItemMeta, ItemView } from "@/lib/ipc-types";
import { ITEM_KINDS } from "@/lib/items";
import { cn } from "@/lib/utils";

import { CopyFieldButton, FieldRow } from "./FieldRow";
import { formatDate, formatDateTime, formatRelative, isoDate } from "./format";
import { KindIcon } from "./KindIcon";
import { NoteMarkdown } from "./Markdown";
import { useNow } from "./use-layout";
import { useVault } from "./vault-context";

type Loaded = { status: "loading" } | { status: "ready"; view: ItemView } | { status: "error"; error: unknown };

/**
 * Fetches the opened item (get_item: non-secret field values only). The view lives in
 * this component's state, so it goes away with the component (another item, lock).
 */
export function useItemView(id: string, attempt: number, onMissing?: () => void): Loaded {
  const key = `${id}#${String(attempt)}`;
  const [result, setResult] = useState<{ key: string; loaded: Loaded } | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc.getItem(id).then(
      (view) => {
        if (!cancelled) setResult({ key, loaded: { status: "ready", view } });
      },
      (error: unknown) => {
        if (cancelled) return;
        setResult({ key, loaded: { status: "error", error } });
        if (ipcErrorCode(error) === "notFound") onMissing?.();
      },
    );
    return () => {
      cancelled = true;
    };
    // `onMissing` is a callback, not an input: re-fetching when it changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key]);
  return result?.key === key ? result.loaded : { status: "loading" };
}

/** Fields worth a row: secrets always, other fields only when they have a value. */
function visibleFields(meta: ItemMeta, fields: readonly FieldView[]): { rows: FieldView[]; note: FieldView | null } {
  const note = meta.kind === "secureNote" ? (fields.find((f) => f.role === "notes" && f.kind !== "hidden") ?? null) : null;
  const rows = fields.filter((f) => f !== note && (f.kind === "hidden" || (f.value ?? "") !== ""));
  return { rows, note };
}

/** The right pane: the opened item with its fields and actions. */
export function ItemDetail({ meta }: { meta: ItemMeta }) {
  const { layout, setDetailElement, actions } = useVault();
  const [attempt, setAttempt] = useState(0);
  const loaded = useItemView(meta.id, attempt, () => {
    void actions.reload();
  });
  const titleId = useId();
  const now = useNow();
  const trashed = meta.trashedAt !== null;
  const kind = ITEM_KINDS[meta.kind];

  return (
    <section
      ref={setDetailElement}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="flex h-full min-h-0 flex-col focus-visible:outline-offset-[-2px]"
    >
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-3">
        {layout === "narrow" ? (
          <Tip label="Back to list" shortcut="Esc">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Back to list"
              onClick={() => {
                actions.back();
              }}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          </Tip>
        ) : null}
        <span className="flex min-w-0 items-center gap-2 pl-1 text-[13px] text-fg-subtle">
          <span className="truncate">{trashed ? "Trash" : kind.label}</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          {trashed ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger-text hover:bg-danger-soft hover:text-danger-text"
                onClick={() => {
                  actions.requestDelete(meta);
                }}
              >
                <Trash2 aria-hidden="true" />
                Delete permanently
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void actions.restore(meta);
                }}
              >
                <ArchiveRestore aria-hidden="true" />
                Restore
              </Button>
            </>
          ) : (
            <>
              <Tip label={meta.favorite ? "Remove from favorites" : "Add to favorites"}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Favorite"
                  aria-pressed={meta.favorite}
                  onClick={() => {
                    void actions.toggleFavorite(meta);
                  }}
                >
                  <Star aria-hidden="true" className={cn(meta.favorite && "fill-current text-accent-text")} />
                </Button>
              </Tip>
              <Tip label="Move to trash">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Move to trash"
                  onClick={() => {
                    void actions.trash(meta);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </Tip>
              <Button
                size="sm"
                className="ml-1"
                onClick={() => {
                  actions.startEdit(meta.id);
                }}
              >
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
          <div className="flex items-start gap-4">
            <KindIcon kind={meta.kind} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
              <h2 id={titleId} className="text-xl leading-7 font-semibold tracking-tight break-words text-fg">
                {meta.title}
              </h2>
              <p className="text-[13px] text-fg-subtle">
                {kind.label}
                {" · "}
                <time dateTime={isoDate(meta.updatedAt)} title={formatDateTime(meta.updatedAt)}>
                  Updated {formatRelative(meta.updatedAt, now)}
                </time>
              </p>
            </div>
          </div>

          {meta.tags.length === 0 ? null : (
            <ul aria-label="Tags" className="-mt-2 flex flex-wrap gap-1.5">
              {meta.tags.map((tag) => (
                <li key={tag}>
                  <button
                    type="button"
                    disabled={trashed}
                    onClick={() => {
                      actions.setView({ type: "tag", tag });
                    }}
                    className="inline-flex h-6 items-center gap-1 rounded-md bg-hover px-2 text-xs font-medium text-fg-muted transition-colors duration-150 hover:bg-selected hover:text-fg disabled:pointer-events-none"
                  >
                    <Hash aria-hidden="true" className="size-3 text-fg-subtle" />
                    {tag}
                    <span className="sr-only">: show items with this tag</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {trashed && meta.trashedAt !== null ? (
            <Alert variant="warning" title="This item is in the trash">
              Moved there {formatRelative(meta.trashedAt, now)}. Restore it to edit it or use its shortcuts again.
            </Alert>
          ) : null}

          {loaded.status === "loading" ? (
            <FieldsSkeleton />
          ) : loaded.status === "error" ? (
            <DetailError
              error={loaded.error}
              onRetry={() => {
                setAttempt((n) => n + 1);
              }}
            />
          ) : (
            <Fields meta={meta} view={loaded.view} />
          )}

          <footer className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle">
            <span>
              Created{" "}
              <time dateTime={isoDate(meta.createdAt)} title={formatDateTime(meta.createdAt)}>
                {formatDate(meta.createdAt)}
              </time>
            </span>
            <span>
              Updated{" "}
              <time dateTime={isoDate(meta.updatedAt)} title={formatDateTime(meta.updatedAt)}>
                {formatDate(meta.updatedAt)}
              </time>
            </span>
          </footer>
        </div>
      </div>
    </section>
  );
}

function Fields({ meta, view }: { meta: ItemMeta; view: ItemView }) {
  const { rows, note } = visibleFields(meta, view.fields);
  return (
    <>
      {note === null ? null : (
        <article
          aria-label="Note"
          className="relative rounded-lg border border-line bg-surface px-5 py-4 shadow-highlight"
        >
          {(note.value ?? "") === "" ? (
            <p className="text-fg-subtle">This note is empty.</p>
          ) : (
            <>
              <div className="absolute top-2 right-2">
                <CopyFieldButton itemId={meta.id} field={note} />
              </div>
              <div className="pr-8">
                <NoteMarkdown text={note.value ?? ""} />
              </div>
            </>
          )}
        </article>
      )}
      {rows.length === 0 ? (
        note === null ? (
          <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-fg-subtle">
            No fields yet. Edit the item to add some.
          </p>
        ) : null
      ) : (
        <dl className="divide-y divide-line rounded-lg border border-line bg-surface shadow-highlight">
          {rows.map((field) => (
            <FieldRow key={field.id} itemId={meta.id} field={field} />
          ))}
        </dl>
      )}
    </>
  );
}

function FieldsSkeleton() {
  return (
    <div
      aria-busy="true"
      className="flex animate-fade-in flex-col divide-y divide-line rounded-lg border border-line bg-surface [animation-delay:150ms]"
    >
      <span className="sr-only">Loading fields</span>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

function DetailError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const copy = friendlyError(error);
  const missing = ipcErrorCode(error) === "notFound";
  return (
    <Alert
      variant="danger"
      role="alert"
      title={missing ? "This item no longer exists" : "Couldn't open this item"}
      action={
        missing ? undefined : (
          <Button size="sm" onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        )
      }
    >
      {missing ? "It may have been deleted. The list has been refreshed." : copy.description}
    </Alert>
  );
}

/** The detail pane when nothing is open. */
export function NoSelection() {
  const { setDetailElement, counts } = useVault();
  return (
    <section
      ref={setDetailElement}
      tabIndex={-1}
      aria-label="Item details"
      className="flex h-full items-center justify-center p-6 outline-none"
    >
      <div className="flex max-w-xs flex-col items-center gap-4 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-elevated text-fg-subtle shadow-highlight">
          <MousePointerClick aria-hidden="true" className="size-5" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-fg">{counts.all === 0 ? "Nothing to show yet" : "No item selected"}</p>
          <p className="text-[13px] text-fg-muted">
            {counts.all === 0 ? "Items you add open here." : "Choose an item in the list to see its details."}
          </p>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-2 text-xs text-fg-subtle">
          <dt className="text-right">Search</dt>
          <dd>
            <KbdCombo combo="Ctrl+F" />
          </dd>
          <dt className="text-right">Move</dt>
          <dd className="flex gap-1">
            <KbdCombo combo="Up" />
            <KbdCombo combo="Down" />
          </dd>
          <dt className="text-right">New item</dt>
          <dd>
            <KbdCombo combo="Ctrl+N" />
          </dd>
          <dt className="text-right">Commands</dt>
          <dd>
            <KbdCombo combo="Ctrl+K" />
          </dd>
        </dl>
      </div>
    </section>
  );
}
