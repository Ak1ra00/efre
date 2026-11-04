/**
 * Ctrl+K command palette (SPEC §6: "a Ctrl+K command palette for every action"). Lists
 * every enabled command from the registry, grouped in COMMAND_GROUPS order, with its
 * shortcut. Fuzzy filter; Enter runs the highlighted command and closes; Esc closes.
 *
 * cmdk's <Command> sits inside our DialogContent (not Command.Dialog), and its vim
 * bindings are off: with them on, cmdk would swallow Ctrl+K (it means "up" there).
 */
import { Command as Cmdk, defaultFilter } from "cmdk";
import { CornerDownLeft, Search } from "lucide-react";
import { useRef, useState } from "react";

import { type Command, useCommands } from "@/app/commands";
import { toastError } from "@/app/toast-error";
import { useUIState } from "@/app/ui-state";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdCombo } from "@/components/ui/kbd";

/** Commands grouped in registry order (the registry already sorts by group). */
function groupCommands(commands: readonly Command[]): [string, Command[]][] {
  const groups = new Map<string, Command[]>();
  for (const command of commands) {
    const list = groups.get(command.group) ?? [];
    list.push(command);
    groups.set(command.group, list);
  }
  return [...groups];
}

/**
 * cmdk's scorer also matches letters scattered across the title, group and keywords
 * (for example "copy" against "Custom" in "Go to"). Those scores sit far below a real
 * match, so they are dropped instead of cluttering the list.
 */
const MIN_SCORE = 0.05;

/** Items are keyed by id; match on the title first, then group and keywords. */
export function filter(value: string, search: string, keywords?: string[]): number {
  const [title, ...rest] = keywords ?? [];
  const score = defaultFilter(title ?? value, search, rest);
  return score < MIN_SCORE ? 0 : score;
}

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useUIState();
  const commands = useCommands().filter((command) => command.enabled !== false);
  const [search, setSearch] = useState("");
  // Set when a command ran: it decides where focus goes, not the closing palette.
  const ranCommand = useRef(false);

  const run = (command: Command) => {
    ranCommand.current = true;
    setPaletteOpen(false);
    setSearch("");
    // After the palette has closed (and released focus), so the command can open
    // another dialog or move focus.
    setTimeout(() => {
      try {
        Promise.resolve(command.run()).catch((err: unknown) => toastError(err));
      } catch (err: unknown) {
        toastError(err);
      }
    }, 0);
  };

  return (
    <Dialog
      open={paletteOpen}
      onOpenChange={(open) => {
        if (open) ranCommand.current = false;
        else setSearch("");
        setPaletteOpen(open);
      }}
    >
      <DialogContent
        size="md"
        showClose={false}
        aria-describedby={undefined}
        className="top-[12%] translate-y-0 overflow-hidden sm:top-[16%]"
        onOpenAutoFocus={() => {
          ranCommand.current = false;
        }}
        onCloseAutoFocus={(event) => {
          if (ranCommand.current) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Cmdk label="Command palette" vimBindings={false} loop filter={filter} className="flex min-h-0 flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
            <Cmdk.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Type a command…"
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
            <KbdCombo combo="Esc" className="shrink-0" />
          </div>
          <Cmdk.List className="max-h-[min(360px,55dvh)] overflow-y-auto overscroll-contain p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-subtle">
            <Cmdk.Empty className="px-3 py-10 text-center text-sm text-fg-muted">
              No command matches “{search.trim()}”.
            </Cmdk.Empty>
            {groupCommands(commands).map(([group, items]) => (
              <Cmdk.Group key={group} heading={group}>
                {items.map((command) => (
                  <Cmdk.Item
                    key={command.id}
                    value={command.id}
                    keywords={[command.title, group, ...(command.keywords ?? [])]}
                    onSelect={() => {
                      run(command);
                    }}
                    className="group relative flex h-9 cursor-default items-center gap-3 rounded-md px-2.5 text-sm text-fg-muted outline-none select-none data-[selected=true]:bg-hover data-[selected=true]:text-fg"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent opacity-0 group-data-[selected=true]:opacity-100"
                    />
                    {command.icon === undefined ? (
                      <span aria-hidden="true" className="size-4 shrink-0" />
                    ) : (
                      <command.icon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-fg-subtle group-data-[selected=true]:text-accent-text"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{command.title}</span>
                    {command.shortcut === undefined ? null : <KbdCombo combo={command.shortcut} className="shrink-0" />}
                  </Cmdk.Item>
                ))}
              </Cmdk.Group>
            ))}
          </Cmdk.List>
          <div
            aria-hidden="true"
            className="flex items-center justify-end gap-4 border-t border-line px-4 py-2 text-xs text-fg-subtle"
          >
            <span className="inline-flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              Navigate
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft className="size-3" />
              </Kbd>
              Run
            </span>
          </div>
        </Cmdk>
      </DialogContent>
    </Dialog>
  );
}
