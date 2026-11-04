import { render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { CommandRegistryProvider, useRegisterCommands } from "./commands";
import { ShortcutSheet } from "./ShortcutSheet";
import { UIStateProvider, useUIState } from "./ui-state";

function Open() {
  const { setShortcutsOpen } = useUIState();
  useEffect(() => {
    setShortcutsOpen(true);
  }, [setShortcutsOpen]);
  useRegisterCommands([
    { id: "app.lock", title: "Lock vault", group: "Vault", shortcut: "Ctrl+L", run: () => undefined },
    { id: "item.trash", title: "Move to trash", group: "Item", shortcut: "Delete", run: () => undefined },
  ]);
  return null;
}

describe("ShortcutSheet", () => {
  it("lists every shortcut with a short description, plus extra registered ones", async () => {
    render(
      <UIStateProvider>
        <CommandRegistryProvider>
          <Open />
          <ShortcutSheet />
        </CommandRegistryProvider>
      </UIStateProvider>,
    );
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const rows = within(sheet)
      .getAllByRole("term")
      .map((term) => [term.textContent, term.nextElementSibling?.textContent ?? ""]);
    const combo = (keys: string): unknown => expect.stringContaining(keys);
    expect(rows).toEqual([
      ["Command palette: every action", combo("Ctrl+K")],
      ["Lock vault", combo("Ctrl+L")],
      ["Show these shortcuts", combo("?")],
      ["Back, or close a dialog", combo("Esc")],
      ["New item", combo("Ctrl+N")],
      ["Search", combo("Ctrl+F")],
      ["Copy the selected item's password", combo("Ctrl+C")],
      ["Copy the selected item's username", combo("Ctrl+B")],
      // Ctrl+L is already listed; Delete isn't.
      ["Move to trash", combo("Delete")],
    ]);
  });
});
