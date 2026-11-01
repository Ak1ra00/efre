/**
 * PLACEHOLDER (E0). Owned by E3: replace freely, keep this path and export name.
 * Mounted globally while unlocked; opened with "?" via useUIState().shortcutsOpen.
 * Lists every registered command that has a shortcut, plus keys that aren't commands.
 */
import { useCommands } from "./commands";
import { useUIState } from "./ui-state";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KbdCombo } from "@/components/ui/kbd";

const STATIC_SHORTCUTS = [
  { combo: "Ctrl+K", title: "Command palette" },
  { combo: "Esc", title: "Back / close" },
] as const;

export function ShortcutSheet() {
  const { shortcutsOpen, setShortcutsOpen } = useUIState();
  const commands = useCommands().filter((c) => c.shortcut !== undefined);
  const rows = [
    ...STATIC_SHORTCUTS,
    ...commands.map((c) => ({ combo: c.shortcut ?? "", title: c.title })),
  ];
  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>efre works without a mouse.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="flex flex-col">
            {rows.map((row) => (
              <div key={`${row.combo}-${row.title}`} className="flex h-9 items-center justify-between gap-4">
                <dt className="text-fg-muted">{row.title}</dt>
                <dd>
                  <KbdCombo combo={row.combo} />
                </dd>
              </div>
            ))}
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
