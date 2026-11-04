import { defaultRangeExtractor, observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUpDown, CircleAlert, Inbox, RotateCw, Search, SearchX, Star, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { KbdCombo } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import type { ItemMeta } from "@/lib/ipc-types";
import { ITEM_KIND_ORDER, ITEM_KINDS } from "@/lib/items";
import { cn } from "@/lib/utils";

import { formatDateTime, formatRelative, formatRelativeShort } from "./format";
import { KindIcon } from "./KindIcon";
import { highlightRuns, KIND_NOUN_PLURALS, type SearchHit, SORT_OPTIONS, type SortKey, viewLabel } from "./search";
import { useNow } from "./use-layout";
import { useVault } from "./vault-context";

export const ROW_HEIGHT = 56;

/** One printable character (a code point), for type-to-search. */
const SINGLE_CHARACTER = /^.$/u;

/** The middle pane: search, sort, and the virtualized list of the current view. */
export function ItemList() {
  const { state, hits, selected, searchRef, actions } = useVault();
  const listboxId = useId();
  const headingId = useId();
  const optionId = (id: string) => `${listboxId}-${id}`;
  const label = viewLabel(state.view);
  const selectedIndex = selected === null ? -1 : hits.findIndex((hit) => hit.item.id === selected.id);
  const activeId = selectedIndex === -1 ? undefined : optionId(hits[selectedIndex]?.item.id ?? "");
  const hasList = state.items !== null && hits.length > 0;

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        actions.move(event.key === "ArrowDown" ? "next" : "previous");
        return;
      case "Enter":
        event.preventDefault();
        actions.openSelected();
        return;
      case "Escape":
        // First Esc clears the search, the next one leaves it.
        event.preventDefault();
        if (state.query !== "") actions.setQuery("");
        else actions.focusList();
        return;
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <Input
            ref={searchRef}
            role="combobox"
            aria-expanded={hasList}
            aria-controls={hasList ? listboxId : undefined}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={`Search ${label}`}
            aria-keyshortcuts="Control+F"
            placeholder="Search"
            value={state.query}
            maxLength={256}
            onChange={(event) => {
              actions.setQuery(event.target.value);
            }}
            onKeyDown={onSearchKeyDown}
            className="pr-16 pl-8"
          />
          {state.query === "" ? (
            <KbdCombo combo="Ctrl+F" className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2" />
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear search"
              className="absolute top-1/2 right-0.5 size-7 -translate-y-1/2"
              onClick={() => {
                actions.setQuery("");
                actions.focusSearch();
              }}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
        <SortMenu sort={state.sort} onSort={actions.setSort} />
      </div>
      <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-4">
        <h2 id={headingId} className="min-w-0 truncate text-xs font-medium text-fg-muted">
          {label}
        </h2>
        {state.items === null ? null : (
          <span className="text-xs text-fg-subtle tabular-nums">
            {state.query === "" ? hits.length : `${String(hits.length)} found`}
          </span>
        )}
        {state.view.type === "trash" && hits.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-danger-text hover:bg-danger-soft hover:text-danger-text"
            onClick={actions.requestEmptyTrash}
          >
            <Trash2 aria-hidden="true" />
            Empty trash
          </Button>
        ) : null}
      </div>
      <ResultsAnnouncer query={state.query} count={hits.length} />
      {state.items === null ? (
        state.loadFailed ? (
          <LoadFailed />
        ) : (
          <ListSkeleton />
        )
      ) : hits.length === 0 ? (
        <ListEmpty />
      ) : (
        <VirtualList
          hits={hits}
          selectedIndex={selectedIndex}
          listboxId={listboxId}
          optionId={optionId}
          label={label}
          activeId={activeId}
        />
      )}
    </section>
  );
}

function SortMenu({ sort, onSort }: { sort: SortKey; onSort: (sort: SortKey) => void }) {
  const current = SORT_OPTIONS.find((option) => option.key === sort) ?? SORT_OPTIONS[0];
  return (
    <DropdownMenu modal={false}>
      <Tip label={`Sort: ${current?.label ?? ""}`}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Sort: ${current?.label ?? ""}`}>
            <ArrowUpDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value) => {
            const option = SORT_OPTIONS.find((o) => o.key === value);
            if (option !== undefined) onSort(option.key);
          }}
        >
          {SORT_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.key} value={option.key}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Tells screen readers how many items match, once typing pauses. */
function ResultsAnnouncer({ query, count }: { query: string; count: number }) {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      setMessage(query.trim() === "" ? "" : count === 0 ? "No items found" : `${String(count)} ${count === 1 ? "item" : "items"} found`);
    }, 500);
    return () => {
      clearTimeout(timer);
    };
  }, [query, count]);
  return (
    <p role="status" className="sr-only">
      {message}
    </p>
  );
}

interface VirtualListProps {
  hits: readonly SearchHit[];
  selectedIndex: number;
  listboxId: string;
  optionId: (id: string) => string;
  label: string;
  activeId: string | undefined;
}

function VirtualList({ hits, selectedIndex, listboxId, optionId, label, activeId }: VirtualListProps) {
  const { state, listRef, actions } = useVault();
  const now = useNow();
  const pointer = useRef(false);

  // eslint-disable-next-line react-hooks/incompatible-library -- efre doesn't use the React Compiler; TanStack Virtual is the virtualizer ARCHITECTURE §12 chose.
  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    paddingEnd: 8,
    getItemKey: (index) => hits[index]?.item.id ?? index,
    // Before the list has been laid out it measures 0 px and would render nothing:
    // assume a window-high list until the real size arrives.
    observeElementRect: (instance, onRect) =>
      observeElementRect(instance, (rect) => {
        onRect(rect.height > 0 ? rect : { width: rect.width, height: window.innerHeight });
      }),
    // Keep the selected option rendered: aria-activedescendant must point at a real element.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (selectedIndex >= 0 && !indexes.includes(selectedIndex)) {
        indexes.push(selectedIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    useFlushSync: false,
  });

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey) return;
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? ROW_HEIGHT) / ROW_HEIGHT) - 1);
    const moves: Partial<Record<string, () => void>> = {
      ArrowDown: () => {
        actions.move("next");
      },
      ArrowUp: () => {
        actions.move("previous");
      },
      Home: () => {
        actions.move("first");
      },
      End: () => {
        actions.move("last");
      },
      PageDown: () => {
        actions.move("next", page);
      },
      PageUp: () => {
        actions.move("previous", page);
      },
      Enter: () => {
        actions.openSelected();
      },
    };
    const run = event.ctrlKey ? undefined : moves[event.key];
    if (run !== undefined) {
      event.preventDefault();
      run();
      return;
    }
    // Typing a letter starts a search ("?" stays the shortcut sheet).
    if (!event.ctrlKey && SINGLE_CHARACTER.test(event.key) && event.key !== " " && event.key !== "?") {
      event.preventDefault();
      actions.setQuery(state.query + event.key);
      actions.focusSearch({ selectAll: false });
    }
  };

  const showDate = state.view.type === "trash" ? "trashed" : state.sort === "title" ? null : state.sort;

  return (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={label}
      aria-activedescendant={activeId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={() => {
        pointer.current = true;
      }}
      onFocus={(event) => {
        const byPointer = pointer.current;
        pointer.current = false;
        if (event.target !== event.currentTarget || byPointer) return;
        // Keyboard focus with nothing selected here: start at the top.
        if (selectedIndex === -1) actions.move("first");
      }}
      onBlur={() => {
        pointer.current = false;
      }}
      className={cn(
        "group relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
        selectedIndex === -1 ? "focus-visible:outline-offset-[-2px]" : "focus-visible:outline-none",
      )}
    >
      <div role="presentation" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const hit = hits[row.index];
          if (hit === undefined) return null;
          return (
            <ItemRow
              key={row.key}
              id={optionId(hit.item.id)}
              hit={hit}
              start={row.start}
              index={row.index}
              count={hits.length}
              selected={row.index === selectedIndex}
              date={showDate}
              now={now}
              onSelect={() => {
                actions.select(hit.item.id, { open: true });
              }}
              onToggleFavorite={
                hit.item.trashedAt === null
                  ? () => {
                      void actions.toggleFavorite(hit.item);
                    }
                  : null
              }
            />
          );
        })}
      </div>
    </div>
  );
}

interface ItemRowProps {
  id: string;
  hit: SearchHit;
  start: number;
  index: number;
  count: number;
  selected: boolean;
  date: "updated" | "created" | "trashed" | null;
  now: number;
  onSelect: () => void;
  onToggleFavorite: (() => void) | null;
}

function dateOf(item: ItemMeta, date: "updated" | "created" | "trashed"): number | null {
  if (date === "updated") return item.updatedAt;
  if (date === "created") return item.createdAt;
  return item.trashedAt;
}

const DATE_PREFIX = { updated: "Updated", created: "Created", trashed: "Deleted" } as const;

function ItemRow({ id, hit, start, index, count, selected, date, now, onSelect, onToggleFavorite }: ItemRowProps) {
  const { item } = hit;
  const subtitle = item.username ?? ITEM_KINDS[item.kind].label;
  const when = date === null ? null : dateOf(item, date);
  // One clear name for screen readers: "GitHub, octocat, favorite, Updated 3d ago".
  const name = [
    item.title,
    subtitle,
    item.favorite ? "favorite" : null,
    when === null || date === null ? null : `${DATE_PREFIX[date]} ${formatRelative(when, now)}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
  return (
    <div
      id={id}
      role="option"
      aria-label={name}
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={count}
      onClick={onSelect}
      className="absolute top-0 left-0 w-full px-2"
      style={{ height: ROW_HEIGHT, transform: `translateY(${String(start)}px)` }}
    >
      <div
        className={cn(
          "group/row relative flex h-full cursor-default items-center gap-3 rounded-lg px-2.5 transition-colors duration-150",
          selected
            ? "bg-selected group-focus-visible:outline-2 group-focus-visible:outline-offset-[-2px] group-focus-visible:outline-ring"
            : "hover:bg-hover",
        )}
      >
        {selected ? <span aria-hidden="true" className="absolute inset-y-3.5 left-0 w-0.5 rounded-full bg-accent" /> : null}
        <KindIcon kind={item.kind} active={selected} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-fg">
            <Highlighted text={item.title} positions={hit.titlePositions} />
          </span>
          <span className="truncate text-[13px] text-fg-subtle">
            {item.username === null ? subtitle : <Highlighted text={subtitle} positions={hit.usernamePositions} />}
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-center gap-1 self-stretch py-2">
          {when === null || date === null ? null : (
            <span aria-hidden="true" className="text-xs text-fg-subtle tabular-nums" title={formatDateTime(when)}>
              {formatRelativeShort(when, now)}
            </span>
          )}
          {onToggleFavorite === null ? (
            item.favorite ? (
              <Star aria-hidden="true" className="size-3.5 fill-current text-accent-text" />
            ) : null
          ) : (
            // Mouse shortcut only: keyboard and screen-reader users have the detail's
            // favorite button and the palette command.
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onToggleFavorite();
              }}
              className={cn(
                "-m-1 rounded p-1 text-fg-subtle transition-[color,opacity] duration-150 hover:text-accent-text",
                item.favorite ? "text-accent-text" : "opacity-0 group-hover/row:opacity-100",
              )}
            >
              <Star className={cn("size-3.5", item.favorite && "fill-current")} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Highlighted({ text, positions }: { text: string; positions: readonly number[] }) {
  if (positions.length === 0) return text;
  return highlightRuns(text, positions).map((run, i) =>
    run.match ? (
      <mark key={i} className="rounded-[2px] bg-accent-soft text-accent-text">
        {run.text}
      </mark>
    ) : (
      <span key={i}>{run.text}</span>
    ),
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" className="flex animate-fade-in flex-col gap-1 px-2 [animation-delay:150ms]">
      <span className="sr-only">Loading items</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 px-2.5">
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function LoadFailed() {
  const { actions } = useVault();
  const [retrying, setRetrying] = useState(false);
  return (
    <EmptyState
      icon={CircleAlert}
      title="Couldn't load your items"
      description="Your vault is unlocked, but efre couldn't read the item list."
      action={
        <Button
          size="sm"
          loading={retrying}
          onClick={() => {
            setRetrying(true);
            void actions.reload().finally(() => {
              setRetrying(false);
            });
          }}
        >
          {retrying ? null : <RotateCw aria-hidden="true" />}
          Try again
        </Button>
      }
    />
  );
}

function ListEmpty() {
  const { state, counts, actions } = useVault();
  const { view, query } = state;
  if (query.trim() !== "") {
    return (
      <EmptyState
        icon={SearchX}
        title={`No results for “${query.trim()}”`}
        description={
          view.type === "all"
            ? "Search looks at titles, usernames, tags and types. Try fewer letters."
            : `Nothing in ${viewLabel(view)} matches. Try fewer letters, or search everything.`
        }
        action={
          <>
            {view.type === "all" ? null : (
              <Button
                size="sm"
                onClick={() => {
                  actions.setView({ type: "all" });
                }}
              >
                Search all items
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                actions.setQuery("");
                actions.focusSearch();
              }}
            >
              Clear search
            </Button>
          </>
        }
      />
    );
  }
  if (view.type === "trash") {
    return (
      <EmptyState
        icon={Trash2}
        title="Trash is empty"
        description="Items you move to the trash stay here until you restore them or delete them for good."
      />
    );
  }
  if (counts.all === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Your vault is empty"
        description="Add a login, note or card. Everything is encrypted on this PC and opens only with your YubiKey."
        action={
          <div className="flex flex-col items-center gap-3">
            <div className="flex flex-wrap justify-center gap-2">
              {ITEM_KIND_ORDER.map((kind, i) => {
                const { icon: Icon, label } = ITEM_KINDS[kind];
                return (
                  <Button
                    key={kind}
                    size="sm"
                    variant={i === 0 ? "primary" : "secondary"}
                    onClick={() => {
                      actions.startCreate(kind);
                    }}
                  >
                    <Icon aria-hidden="true" />
                    {label}
                  </Button>
                );
              })}
            </div>
            <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
              Or press <KbdCombo combo="Ctrl+N" />
            </p>
          </div>
        }
      />
    );
  }
  if (view.type === "favorites") {
    return (
      <EmptyState
        icon={Star}
        title="No favorites yet"
        description="Star the items you use most, and they'll wait for you here."
      />
    );
  }
  if (view.type === "kind") {
    const { icon, noun } = ITEM_KINDS[view.kind];
    const plural = KIND_NOUN_PLURALS[view.kind];
    return (
      <EmptyState
        icon={icon}
        title={`No ${plural} yet`}
        description={`The ${plural} you add will appear here.`}
        action={
          <Button
            size="sm"
            onClick={() => {
              actions.startCreate(view.kind);
            }}
          >
            New {noun}
          </Button>
        }
      />
    );
  }
  return <EmptyState icon={Inbox} title="Nothing here" description="No items have this tag any more." />;
}
