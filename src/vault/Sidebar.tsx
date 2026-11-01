import {
  Hash,
  Layers,
  Lock,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Star,
  Tag,
  Trash2,
  WandSparkles,
} from "lucide-react";

import { useAppStatus } from "@/app/app-status";
import { useUIState } from "@/app/ui-state";
import { EfreMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KbdCombo } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { ITEM_KIND_ORDER, ITEM_KINDS } from "@/lib/items";
import { cn } from "@/lib/utils";

import { NewItemMenu } from "./NewItemMenu";
import { KIND_PLURALS, sameView, type VaultView } from "./search";
import { useVault } from "./vault-context";

interface Entry {
  key: string;
  view: VaultView;
  label: string;
  icon: LucideIcon;
  count: number;
}

function useEntries() {
  const { counts } = useVault();
  const top: Entry[] = [
    { key: "all", view: { type: "all" }, label: "All items", icon: Layers, count: counts.all },
    { key: "favorites", view: { type: "favorites" }, label: "Favorites", icon: Star, count: counts.favorites },
  ];
  const kinds: Entry[] = ITEM_KIND_ORDER.map((kind) => ({
    key: `kind-${kind}`,
    view: { type: "kind", kind },
    label: KIND_PLURALS[kind],
    icon: ITEM_KINDS[kind].icon,
    count: counts.kinds[kind],
  }));
  const tags: Entry[] = counts.tags.map(({ tag, count }) => ({
    key: `tag-${tag}`,
    view: { type: "tag", tag },
    label: tag,
    icon: Hash,
    count,
  }));
  const trash: Entry = { key: "trash", view: { type: "trash" }, label: "Trash", icon: Trash2, count: counts.trash };
  return { top, kinds, tags, trash };
}

/** Sidebar: views with counts, tags, trash, and the generator, settings and lock. */
export function Sidebar() {
  const { sidebarExpanded } = useVault();
  return sidebarExpanded ? <FullSidebar /> : <Rail />;
}

function FullSidebar() {
  const { state, actions } = useVault();
  const { top, kinds, tags, trash } = useEntries();
  const item = (entry: Entry) => (
    <li key={entry.key}>
      <NavButton
        entry={entry}
        active={sameView(entry.view, state.view)}
        onSelect={() => {
          actions.setView(entry.view);
        }}
      />
    </li>
  );
  return (
    <aside aria-label="Sidebar" className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2.5 pr-2 pl-4">
        <EfreMark className="size-6" />
        <span className="text-sm font-semibold tracking-tight">efre</span>
        <Tip label="Collapse sidebar">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Collapse sidebar"
            className="ml-auto"
            onClick={() => {
              actions.setSidebarExpanded(false);
            }}
          >
            <PanelLeftClose aria-hidden="true" />
          </Button>
        </Tip>
      </div>
      <div className="px-3 pb-3">
        <NewItemMenu compact={false} />
      </div>
      <nav aria-label="Vault" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3">
        <ul className="flex flex-col gap-0.5">{top.map(item)}</ul>
        <section aria-labelledby="sidebar-types" className="flex flex-col gap-1">
          <h2 id="sidebar-types" className="px-2 text-xs font-medium text-fg-subtle">
            Types
          </h2>
          <ul className="flex flex-col gap-0.5">{kinds.map(item)}</ul>
        </section>
        {tags.length === 0 ? null : (
          <section aria-labelledby="sidebar-tags" className="flex flex-col gap-1">
            <h2 id="sidebar-tags" className="px-2 text-xs font-medium text-fg-subtle">
              Tags
            </h2>
            <ul className="flex flex-col gap-0.5">{tags.map(item)}</ul>
          </section>
        )}
        <ul className="flex flex-col gap-0.5">{item(trash)}</ul>
      </nav>
      <SidebarFooter compact={false} />
    </aside>
  );
}

function NavButton({ entry, active, onSelect }: { entry: Entry; active: boolean; onSelect: () => void }) {
  const Icon = entry.icon;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "group relative flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] font-medium text-fg-muted select-none",
        "transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:outline-offset-0",
        active && "bg-selected text-fg hover:bg-selected",
      )}
    >
      {active ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" /> : null}
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0 transition-colors duration-150",
          active ? "text-accent-text" : "text-fg-subtle group-hover:text-fg-muted",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left">{entry.label}</span>
      {entry.count > 0 ? (
        <span className="text-xs text-fg-subtle tabular-nums">
          {entry.count}
          <span className="sr-only"> {entry.count === 1 ? "item" : "items"}</span>
        </span>
      ) : null}
    </button>
  );
}

function railLabel(entry: Entry): string {
  return entry.count > 0 ? `${entry.label} (${String(entry.count)})` : entry.label;
}

function RailButton({ entry, active, onSelect }: { entry: Entry; active: boolean; onSelect: () => void }) {
  const Icon = entry.icon;
  return (
    <Tip label={railLabel(entry)} side="right">
      <button
        type="button"
        aria-label={railLabel(entry)}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        className={cn(
          "relative flex size-10 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors duration-150",
          "hover:bg-hover hover:text-fg focus-visible:outline-offset-0",
          active && "bg-selected text-accent-text hover:bg-selected hover:text-accent-text",
        )}
      >
        {active ? <span aria-hidden="true" className="absolute inset-y-2.5 left-0 w-0.5 rounded-full bg-accent" /> : null}
        <Icon aria-hidden="true" className="size-[18px]" />
      </button>
    </Tip>
  );
}

function Rail() {
  const { state, layout, actions } = useVault();
  const { top, kinds, tags, trash } = useEntries();
  const tagView = state.view.type === "tag" ? state.view.tag : "";
  const railItem = (entry: Entry) => (
    <li key={entry.key}>
      <RailButton
        entry={entry}
        active={sameView(entry.view, state.view)}
        onSelect={() => {
          actions.setView(entry.view);
        }}
      />
    </li>
  );
  return (
    <aside aria-label="Sidebar" className="flex w-14 shrink-0 flex-col items-center border-r border-line bg-surface">
      <div className="flex flex-col items-center gap-2 py-2">
        {layout === "narrow" ? (
          <EfreMark className="my-1 size-7" />
        ) : (
          <Tip label="Expand sidebar" side="right">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Expand sidebar"
              onClick={() => {
                actions.setSidebarExpanded(true);
              }}
            >
              <PanelLeftOpen aria-hidden="true" />
            </Button>
          </Tip>
        )}
        <NewItemMenu compact />
      </div>
      <nav aria-label="Vault" className="flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto py-1">
        <ul className="flex flex-col items-center gap-1">
          {top.map(railItem)}
          <li aria-hidden="true" className="my-1 h-px w-6 bg-line" />
          {kinds.map(railItem)}
          <li aria-hidden="true" className="my-1 h-px w-6 bg-line" />
          {tags.length === 0 ? null : (
            <li>
              <DropdownMenu>
                <Tip label="Tags" side="right">
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={tagView === "" ? "Tags" : `Tags (showing ${tagView})`}
                      className={cn(
                        "relative flex size-10 items-center justify-center rounded-md text-fg-subtle transition-colors duration-150",
                        "hover:bg-hover hover:text-fg focus-visible:outline-offset-0 data-[state=open]:bg-hover",
                        tagView !== "" && "bg-selected text-accent-text hover:bg-selected hover:text-accent-text",
                      )}
                    >
                      {tagView === "" ? null : (
                        <span aria-hidden="true" className="absolute inset-y-2.5 left-0 w-0.5 rounded-full bg-accent" />
                      )}
                      <Tag aria-hidden="true" className="size-[18px]" />
                    </button>
                  </DropdownMenuTrigger>
                </Tip>
                <DropdownMenuContent side="right" align="start" className="max-h-80">
                  <DropdownMenuLabel>Tags</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={tagView}
                    onValueChange={(tag) => {
                      actions.setView({ type: "tag", tag });
                    }}
                  >
                    {tags.map((entry) => (
                      <DropdownMenuRadioItem key={entry.key} value={entry.label}>
                        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                        <span className="text-xs text-fg-subtle tabular-nums">{entry.count}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          )}
          {railItem(trash)}
        </ul>
      </nav>
      <SidebarFooter compact />
    </aside>
  );
}

/** Generator, Settings and Lock. */
function SidebarFooter({ compact }: { compact: boolean }) {
  const ui = useUIState();
  const { lock } = useAppStatus();
  const buttons = [
    {
      key: "generator",
      label: "Password generator",
      icon: WandSparkles,
      run: () => {
        ui.requestGenerator();
      },
    },
    {
      key: "settings",
      label: "Settings",
      icon: Settings,
      run: () => {
        ui.openSettings();
      },
    },
    {
      key: "lock",
      label: "Lock",
      icon: Lock,
      shortcut: "Ctrl+L",
      run: () => {
        void lock();
      },
    },
  ];
  if (compact) {
    return (
      <div className="flex w-full flex-col items-center gap-1 border-t border-line py-2">
        {buttons.map(({ key, label, icon: Icon, shortcut, run }) => (
          <Tip key={key} label={label} side="right" {...(shortcut === undefined ? {} : { shortcut })}>
            <Button variant="ghost" size="icon" aria-label={label} className="size-10" onClick={run}>
              <Icon aria-hidden="true" className="size-[18px]" />
            </Button>
          </Tip>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 border-t border-line p-2">
      {buttons.map(({ key, label, icon: Icon, shortcut, run }) => (
        <Button
          key={key}
          variant="ghost"
          className="h-8 w-full justify-start gap-2.5 px-2 text-[13px] [&_svg]:text-fg-subtle hover:[&_svg]:text-fg-muted"
          onClick={run}
          {...(shortcut === undefined ? {} : { "aria-keyshortcuts": "Control+L" })}
        >
          <Icon aria-hidden="true" />
          {label}
          {shortcut === undefined ? null : <KbdCombo combo={shortcut} className="ml-auto" />}
        </Button>
      ))}
    </div>
  );
}
