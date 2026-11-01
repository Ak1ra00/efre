/**
 * The `?` sheet (SPEC §7): every keyboard shortcut with a short description. Mounted
 * globally while unlocked; opened with "?" via useUIState().shortcutsOpen. The core
 * shortcuts are always listed; any other shortcut a feature registers is added below.
 */
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KbdCombo } from "@/components/ui/kbd";
import { formatShortcut } from "@/lib/shortcut";

import { useCommands } from "./commands";
import { useUIState } from "./ui-state";

interface Row {
  combo: string;
  title: string;
}

const CORE: readonly { heading: string; rows: readonly Row[] }[] = [
  {
    heading: "Anywhere",
    rows: [
      { combo: "Ctrl+K", title: "Command palette: every action" },
      { combo: "Ctrl+L", title: "Lock vault" },
      { combo: "?", title: "Show these shortcuts" },
      { combo: "Esc", title: "Back, or close a dialog" },
    ],
  },
  {
    heading: "Items",
    rows: [
      { combo: "Ctrl+N", title: "New item" },
      { combo: "Ctrl+F", title: "Search" },
      { combo: "Ctrl+C", title: "Copy the selected item's password" },
      { combo: "Ctrl+B", title: "Copy the selected item's username" },
    ],
  },
];

const coreCombos = new Set(CORE.flatMap((group) => group.rows.map((row) => formatShortcut(row.combo))));

export function ShortcutSheet() {
  const { shortcutsOpen, setShortcutsOpen } = useUIState();
  // Registered shortcuts the core list doesn't already describe (one row per combo).
  const extra = new Map<string, Row>();
  for (const command of useCommands()) {
    if (command.shortcut === undefined) continue;
    const key = formatShortcut(command.shortcut);
    if (!coreCombos.has(key) && !extra.has(key)) extra.set(key, { combo: command.shortcut, title: command.title });
  }
  const groups = extra.size === 0 ? CORE : [...CORE, { heading: "More", rows: [...extra.values()] }];

  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>efre works without a mouse. Ctrl+K finds everything else.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5 pb-6">
          {groups.map((group) => (
            <section key={group.heading} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-fg-subtle">{group.heading}</h3>
              <dl className="flex flex-col">
                {group.rows.map((row) => (
                  <div
                    key={row.combo}
                    className="flex min-h-9 items-center justify-between gap-4 border-b border-line py-1.5 last:border-b-0"
                  >
                    <dt className="text-sm text-fg-muted">{row.title}</dt>
                    <dd className="shrink-0">
                      <KbdCombo combo={row.combo} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
