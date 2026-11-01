import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { type Command, CommandRegistry, CommandRegistryProvider, useCommands, useRegisterCommands } from "./commands";

function Lister() {
  const commands = useCommands();
  return (
    <ul>
      {commands.map((c) => (
        <li key={c.id}>
          <button type="button" disabled={c.enabled === false} onClick={() => void c.run()}>
            {c.group}: {c.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Registrar({ commands }: { commands: Command[] }) {
  useRegisterCommands(commands);
  return null;
}

describe("command registry", () => {
  it("lists registered commands in group order and unregisters on unmount", () => {
    const run = vi.fn();
    const { rerender } = render(
      <CommandRegistryProvider>
        <Registrar commands={[{ id: "app.lock", title: "Lock vault", group: "Vault", run }]} />
        <Registrar
          commands={[
            { id: "item.copy", title: "Copy password", group: "Item", run },
            { id: "x.custom", title: "Something", group: "Other", run },
          ]}
        />
        <Lister />
      </CommandRegistryProvider>,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Item: Copy password",
      "Vault: Lock vault",
      "Other: Something",
    ]);

    rerender(
      <CommandRegistryProvider>
        <Registrar commands={[{ id: "app.lock", title: "Lock vault", group: "Vault", run }]} />
        <Lister />
      </CommandRegistryProvider>,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Vault: Lock vault"]);
  });

  it("runs the latest closure and reflects enabled/title changes", async () => {
    const user = userEvent.setup();
    const seen: number[] = [];
    function Counter() {
      const [count, setCount] = useState(0);
      useRegisterCommands([
        {
          id: "count.log",
          title: `Log ${String(count)}`,
          group: "Item",
          enabled: count < 2,
          run: () => {
            seen.push(count);
          },
        },
      ]);
      return (
        <button
          type="button"
          onClick={() => {
            setCount((c) => c + 1);
          }}
        >
          bump
        </button>
      );
    }
    render(
      <CommandRegistryProvider>
        <Counter />
        <Lister />
      </CommandRegistryProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Item: Log 0" }));
    await user.click(screen.getByRole("button", { name: "bump" }));
    await user.click(screen.getByRole("button", { name: "Item: Log 1" }));
    expect(seen).toEqual([0, 1]);

    await user.click(screen.getByRole("button", { name: "bump" }));
    expect(screen.getByRole("button", { name: "Item: Log 2" })).toBeDisabled();
  });

  it("only notifies listeners when something visible changes", () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const command = { id: "a", title: "A", group: "Item", run: () => undefined };
    registry.set("owner", [command]);
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = registry.getSnapshot();

    // A new run closure alone: no re-render, same snapshot.
    registry.set("owner", [{ ...command, run: () => undefined }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot()).toBe(snapshot);

    registry.set("owner", [{ ...command, title: "B" }]);
    expect(listener).toHaveBeenCalledTimes(2);
    registry.remove("owner");
    expect(registry.getSnapshot()).toEqual([]);
  });

  it("skips disabled commands when run through the snapshot", () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.set("owner", [{ id: "a", title: "A", group: "Item", enabled: false, run }]);
    void registry.getSnapshot()[0]?.run();
    expect(run).not.toHaveBeenCalled();
  });
});
