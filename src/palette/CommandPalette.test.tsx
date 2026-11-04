import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Star } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { type Command, CommandRegistryProvider, useRegisterCommands } from "@/app/commands";
import { UIStateProvider } from "@/app/ui-state";
import { useShortcut } from "@/app/use-shortcut";
import { useUIState } from "@/app/ui-state";
import { Toaster } from "@/components/ui/toast";
import { mockIpc } from "@/test/ipc-mock";

import { CommandPalette } from "./CommandPalette";

function Commands({ commands }: { commands: Command[] }) {
  useRegisterCommands(commands);
  // The shell binds Ctrl+K the same way (src/app/shell-commands.ts).
  const ui = useUIState();
  useShortcut(
    "Ctrl+K",
    () => {
      ui.setPaletteOpen(!ui.paletteOpen);
    },
    { allowInInputs: true },
  );
  return null;
}

function renderPalette(commands: Command[]) {
  return render(
    <UIStateProvider>
      <CommandRegistryProvider>
        <Commands commands={commands} />
        <CommandPalette />
      </CommandRegistryProvider>
      <Toaster />
    </UIStateProvider>,
  );
}

const noop = () => undefined;

describe("CommandPalette", () => {
  it("opens with Ctrl+K, lists commands by group with their shortcuts, and Enter runs the first match", async () => {
    const user = userEvent.setup();
    mockIpc();
    const lock = vi.fn();
    const favorite = vi.fn();
    renderPalette([
      { id: "app.lock", title: "Lock vault", group: "Vault", shortcut: "Ctrl+L", run: lock },
      { id: "item.favorite", title: "Add to favorites", group: "Item", icon: Star, keywords: ["star"], run: favorite },
      { id: "item.hidden", title: "Not available", group: "Item", enabled: false, run: noop },
    ]);

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    // Group order follows COMMAND_GROUPS ("Item" before "Vault"), each under its heading.
    expect(within(palette).getByText("Item")).toBeInTheDocument();
    expect(within(palette).getByText("Vault")).toBeInTheDocument();
    const options = within(palette).getAllByRole("option");
    expect(options).toHaveLength(2);
    const [first, second] = options as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent("Add to favorites");
    expect(second).toHaveTextContent("Lock vault");
    expect(within(second).getByText("Ctrl+L")).toBeInTheDocument();
    expect(within(palette).queryByText("Not available")).not.toBeInTheDocument();

    // Fuzzy: "lck" finds "Lock vault".
    await user.keyboard("lck");
    const matches = within(palette).getAllByRole("option");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toHaveTextContent("Lock vault");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(lock).toHaveBeenCalledTimes(1);
    });
    expect(favorite).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
  });

  it("matches keywords and runs the command clicked", async () => {
    const user = userEvent.setup();
    mockIpc();
    const favorite = vi.fn();
    renderPalette([
      { id: "app.lock", title: "Lock vault", group: "Vault", run: noop },
      { id: "item.favorite", title: "Add to favorites", group: "Item", keywords: ["star"], run: favorite },
    ]);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByPlaceholderText("Type a command…"), "star");
    await user.click(screen.getByRole("option", { name: "Add to favorites" }));
    await waitFor(() => {
      expect(favorite).toHaveBeenCalledTimes(1);
    });
  });

  it("says when nothing matches, and Esc closes it", async () => {
    const user = userEvent.setup();
    mockIpc();
    renderPalette([{ id: "app.lock", title: "Lock vault", group: "Vault", run: noop }]);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByPlaceholderText("Type a command…"), "zzzz");
    expect(screen.getByText("No command matches “zzzz”.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
  });

  it("shows a failing command's error as a toast", async () => {
    const user = userEvent.setup();
    mockIpc();
    renderPalette([
      {
        id: "x.fail",
        title: "Fail",
        group: "Help",
        run: () => Promise.reject(new Error("nope")),
      },
    ]);
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByPlaceholderText("Type a command…"), "fail{Enter}");
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
  });
});
