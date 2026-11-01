/**
 * PLACEHOLDER (E0). Owned by E3: replace freely, keep this path and export name.
 * Mounted globally while unlocked; lists useCommands() (enabled ones), opened with
 * Ctrl+K via useUIState().paletteOpen. Use cmdk's <Command> inside our DialogContent
 * (not Command.Dialog) so it shares the app's dialog styling.
 */
import { Command } from "cmdk";

import { useCommands } from "@/app/commands";
import { useUIState } from "@/app/ui-state";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { KbdCombo } from "@/components/ui/kbd";

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useUIState();
  const commands = useCommands().filter((command) => command.enabled !== false);
  return (
    <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <DialogContent size="md" showClose={false} aria-describedby={undefined} className="top-[20%] translate-y-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        {/* vimBindings off: cmdk would otherwise swallow Ctrl+K (it means "up" there). */}
        <Command label="Command palette" vimBindings={false} className="flex flex-col">
          <Command.Input
            placeholder="Type a command…"
            className="h-12 border-b border-line bg-transparent px-4 text-sm outline-none placeholder:text-fg-subtle"
          />
          <Command.List className="max-h-80 overflow-y-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-fg-muted">No matching command.</Command.Empty>
            {commands.map((command) => (
              <Command.Item
                key={command.id}
                value={`${command.title} ${command.group} ${(command.keywords ?? []).join(" ")}`}
                onSelect={() => {
                  setPaletteOpen(false);
                  void command.run();
                }}
                className="flex h-9 cursor-default items-center gap-2 rounded-md px-3 data-[selected=true]:bg-hover"
              >
                {command.icon === undefined ? null : <command.icon aria-hidden="true" className="size-4 text-fg-subtle" />}
                <span className="flex-1">{command.title}</span>
                {command.shortcut === undefined ? null : <KbdCombo combo={command.shortcut} />}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
