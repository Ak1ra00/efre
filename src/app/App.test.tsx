import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { AppStatus } from "@/lib/ipc-types";
import { makeItemMeta, makeKey, makeStatus } from "@/test/fixtures";
import { mockIpc } from "@/test/ipc-mock";

import { App } from "./App";

function unlocked(overrides: Partial<AppStatus> = {}) {
  return mockIpc()
    .on("app_status", makeStatus({ phase: "unlocked", ...overrides }))
    .on("list_items", [makeItemMeta({ title: "GitHub" }), makeItemMeta({ title: "Old", trashedAt: 1 })]);
}

describe("App phase routing", () => {
  it("shows the loading screen until app_status answers", async () => {
    let answer: (s: AppStatus) => void = () => undefined;
    mockIpc().on("app_status", () => new Promise<AppStatus>((resolve) => (answer = resolve)));
    render(<App />);
    expect(screen.getByText("Starting efre")).toBeInTheDocument();

    answer(makeStatus({ phase: "locked" }));
    expect(await screen.findByRole("heading", { name: "Insert and touch your YubiKey" })).toBeInTheDocument();
  });

  it.each([
    ["unsupported", "Update Windows to use efre"],
    ["setup", "Welcome to efre"],
    ["locked", "Insert and touch your YubiKey"],
  ] as const)("renders the %s screen", async (phase, heading) => {
    mockIpc().on("app_status", makeStatus({ phase }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  });

  it("renders the vault when unlocked, with the global dialogs mounted but closed", async () => {
    unlocked();
    render(<App />);
    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/Only one YubiKey/)).not.toBeInTheDocument();
  });

  it("shows a retryable error when app_status fails", async () => {
    const user = userEvent.setup();
    const ipc = mockIpc().failOnce("app_status", "internal").on("app_status", makeStatus({ phase: "setup" }));
    render(<App />);
    // StrictMode is off in tests, but a second fetch would also be harmless.
    expect(await screen.findByRole("heading", { name: "efre couldn't start" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Welcome to efre" })).toBeInTheDocument();
    expect(ipc.callsTo("app_status").length).toBeGreaterThanOrEqual(2);
  });

  it("unlocks with the status the unlock command returns", async () => {
    const user = userEvent.setup();
    mockIpc()
      .on("app_status", makeStatus({ phase: "locked" }))
      .on("unlock", makeStatus({ phase: "unlocked" }))
      .on("list_items", [makeItemMeta({ title: "Bank" })]);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Bank")).toBeInTheDocument();
  });

  it("drops the unlocked UI at once on the `locked` event, then refetches the status", async () => {
    const ipc = unlocked();
    render(<App />);
    expect(await screen.findByText("GitHub")).toBeInTheDocument();

    ipc.on("app_status", makeStatus({ phase: "locked", lastLockReason: "idle" }));
    await ipc.emit("locked", { reason: "idle" });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Insert and touch your YubiKey" })).toBeInTheDocument();
  });
});

describe("App shell while unlocked", () => {
  it("Ctrl+K toggles the command palette, which lists the shell commands", async () => {
    const user = userEvent.setup();
    unlocked();
    render(<App />);
    await screen.findByText("GitHub");

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Command palette" });
    expect(palette).toHaveTextContent("Lock vault");
    expect(palette).toHaveTextContent("Open settings");

    await user.keyboard("{Control>}k{/Control}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    });
  });

  it("Ctrl+L locks, even from a text field", async () => {
    const user = userEvent.setup();
    const ipc = unlocked().on("lock", null);
    render(<App />);
    await screen.findByText("GitHub");
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByPlaceholderText("Type a command…"), "lo");
    await user.keyboard("{Control>}l{/Control}");
    await waitFor(() => {
      expect(ipc.callsTo("lock")).toHaveLength(1);
    });
  });

  it("? opens the shortcut sheet", async () => {
    const user = userEvent.setup();
    unlocked();
    render(<App />);
    await screen.findByText("GitHub");
    await user.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(sheet).toHaveTextContent("Lock vault");
  });

  it("shows the single-key banner, which opens Settings at YubiKeys", async () => {
    const user = userEvent.setup();
    unlocked({ keys: [makeKey()], singleKeyWarning: true });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Add backup key" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(settings).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "YubiKeys" })).toHaveAttribute("aria-selected", "true");
  });

  it("does not bind the shell shortcuts while locked", async () => {
    const user = userEvent.setup();
    const ipc = mockIpc().on("app_status", makeStatus({ phase: "locked" }));
    render(<App />);
    await screen.findByRole("heading", { name: "Insert and touch your YubiKey" });
    await user.keyboard("{Control>}k{/Control}?{Control>}l{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(ipc.callsTo("lock")).toHaveLength(0);
  });
});
