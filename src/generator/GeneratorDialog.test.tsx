import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UIStateProvider, useUIState } from "@/app/ui-state";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Generated } from "@/lib/ipc-types";
import { mockIpc } from "@/test/ipc-mock";

import { GeneratorDialog } from "./GeneratorDialog";

const PASSWORD: Generated = { value: "Kq7#vX2!mP9$wL4&zR8^", entropyBits: 131 };
const PASSPHRASE: Generated = { value: "cedar-otter-plum-ribbon-quartz-dune", entropyBits: 77.5 };

function Openers({ onUse }: { onUse: (value: string) => void }) {
  const { requestGenerator } = useUIState();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          requestGenerator();
        }}
      >
        Open generator
      </button>
      <button
        type="button"
        onClick={() => {
          requestGenerator(onUse);
        }}
      >
        Generate for field
      </button>
    </>
  );
}

function renderGenerator(onUse: (value: string) => void = () => undefined) {
  return render(
    <TooltipProvider>
      <UIStateProvider>
        <Openers onUse={onUse} />
        <GeneratorDialog />
      </UIStateProvider>
      <Toaster />
    </TooltipProvider>,
  );
}

function generator() {
  return mockIpc()
    .on("generate_password", PASSWORD)
    .on("generate_passphrase", PASSPHRASE)
    .on("copy_generated", { clearsInSeconds: 30 });
}

describe("GeneratorDialog", () => {
  it("generates a password with the IPC.md defaults and shows its strength", async () => {
    const user = userEvent.setup();
    const ipc = generator();
    renderGenerator();
    await user.click(screen.getByRole("button", { name: "Open generator" }));

    const dialog = await screen.findByRole("dialog", { name: "Password generator" });
    const output = await within(dialog).findByRole("status", { name: "Generated password" });
    await waitFor(() => {
      expect(output).toHaveTextContent(PASSWORD.value);
    });
    expect(ipc.callsTo("generate_password")[0]).toEqual({
      options: { length: 20, lowercase: true, uppercase: true, digits: true, symbols: true, avoidAmbiguous: false },
    });
    const meter = within(dialog).getByRole("meter", { name: "Strength" });
    expect(meter).toHaveAttribute("aria-valuetext", "Very strong, about 131 bits of entropy");
    expect(meter).toHaveAccessibleDescription("Far beyond what anyone can guess.");
    // Without a caller there is nothing to "use": Copy is the only action.
    expect(within(dialog).queryByRole("button", { name: /^Use / })).not.toBeInTheDocument();
  });

  it("Copy copies in Rust (copy_generated) and confirms with a toast", async () => {
    const user = userEvent.setup();
    const ipc = generator();
    renderGenerator();
    await user.click(screen.getByRole("button", { name: "Open generator" }));
    const dialog = await screen.findByRole("dialog", { name: "Password generator" });
    const copy = within(dialog).getByRole("button", { name: "Copy" });
    await waitFor(() => {
      expect(copy).toBeEnabled();
    });
    await user.click(copy);
    await waitFor(() => {
      expect(ipc.callsTo("copy_generated")).toHaveLength(1);
    });
    expect(await screen.findByText("The clipboard clears in 30 seconds.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("Use hands the value back to the caller and closes", async () => {
    const user = userEvent.setup();
    generator();
    const onUse = vi.fn();
    renderGenerator(onUse);
    await user.click(screen.getByRole("button", { name: "Generate for field" }));
    const dialog = await screen.findByRole("dialog", { name: "Password generator" });
    const use = within(dialog).getByRole("button", { name: "Use password" });
    await waitFor(() => {
      expect(use).toBeEnabled();
    });
    await user.click(use);
    expect(onUse).toHaveBeenCalledWith(PASSWORD.value);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("regenerates when an option changes, and keeps one kind of character on", async () => {
    const user = userEvent.setup();
    const ipc = generator();
    renderGenerator();
    await user.click(screen.getByRole("button", { name: "Open generator" }));
    const dialog = await screen.findByRole("dialog", { name: "Password generator" });
    await waitFor(() => {
      expect(ipc.callsTo("generate_password")).toHaveLength(1);
    });

    await user.click(within(dialog).getByRole("switch", { name: /Symbols/ }));
    await waitFor(() => {
      expect(ipc.callsTo("generate_password").at(-1)?.options.symbols).toBe(false);
    });
    await user.click(within(dialog).getByRole("switch", { name: /Digits/ }));
    await user.click(within(dialog).getByRole("switch", { name: /Uppercase/ }));
    await waitFor(() => {
      expect(ipc.callsTo("generate_password").at(-1)?.options).toMatchObject({
        lowercase: true,
        uppercase: false,
        digits: false,
        symbols: false,
      });
    });
    // The last kind left can't be switched off.
    expect(within(dialog).getByRole("switch", { name: /Lowercase/ })).toBeDisabled();

    within(dialog).getByRole("slider").focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(ipc.callsTo("generate_password").at(-1)?.options.length).toBe(21);
    });
  });

  it("generates passphrases with the IPC.md defaults", async () => {
    const user = userEvent.setup();
    const ipc = generator();
    renderGenerator(() => undefined);
    await user.click(screen.getByRole("button", { name: "Generate for field" }));
    const dialog = await screen.findByRole("dialog", { name: "Password generator" });
    await user.click(within(dialog).getByRole("tab", { name: "Passphrase" }));
    await waitFor(() => {
      expect(ipc.callsTo("generate_passphrase")[0]).toEqual({
        options: { words: 6, separator: "-", capitalize: false, includeNumber: false },
      });
    });
    expect(await within(dialog).findByText("Strong")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Use passphrase" })).toBeInTheDocument();

    const separator = within(dialog).getByRole("textbox", { name: "Separator" });
    await user.clear(separator);
    await user.type(separator, ".");
    await waitFor(() => {
      expect(ipc.callsTo("generate_passphrase").at(-1)?.options.separator).toBe(".");
    });
  });

  it("explains a failed generation", async () => {
    const user = userEvent.setup();
    mockIpc().fail("generate_password", "invalid", "Choose at least one kind of character.");
    renderGenerator();
    await user.click(screen.getByRole("button", { name: "Open generator" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't generate a password");
    expect(alert).toHaveTextContent("Choose at least one kind of character.");
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
  });
});
