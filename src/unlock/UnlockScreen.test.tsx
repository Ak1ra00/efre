import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "@/app/App";
import { wireError } from "@/dev/mock-ipc";
import type { AppStatus } from "@/lib/ipc-types";
import { makeKey, makeStatus } from "@/test/fixtures";
import { mockIpc } from "@/test/ipc-mock";

import { classifyUnsupported } from "./UnsupportedScreen";

const HEADING = "Insert and touch your YubiKey";
const keys = [makeKey({ nickname: "Primary" }), makeKey({ nickname: "Backup" })];

function locked(overrides: Partial<AppStatus> = {}) {
  return mockIpc()
    .on("app_status", makeStatus({ phase: "locked", keys, ...overrides }))
    .on("list_items", []);
}

describe("UnlockScreen", () => {
  it("names the enrolled keys and unlocks with the returned status", async () => {
    const user = userEvent.setup();
    const ipc = locked().on("unlock", makeStatus({ phase: "unlocked", keys }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: HEADING })).toBeInTheDocument();
    expect(screen.getByText(/Use/).textContent).toContain("Use Primary or Backup.");

    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: HEADING })).not.toBeInTheDocument();
    });
    expect(ipc.callsTo("unlock")).toHaveLength(1);
  });

  it("unlocks with Enter", async () => {
    const user = userEvent.setup();
    const ipc = locked().on("unlock", makeStatus({ phase: "unlocked", keys }));
    render(<App />);
    await screen.findByRole("heading", { name: HEADING });
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(ipc.callsTo("unlock")).toHaveLength(1);
    });
  });

  it("explains a cancelled prompt, including a key Windows didn't recognise", async () => {
    const user = userEvent.setup();
    locked().failOnce("unlock", "authn.cancelled");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Unlock" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unlock cancelled");
    expect(alert).toHaveTextContent("If Windows didn't recognise the key, it isn't enrolled in this vault: try your other key.");
  });

  it("sends a blocked PIN to the backup key", async () => {
    const user = userEvent.setup();
    locked().failOnce("unlock", "authn.pinBlocked");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Unlock" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This key's PIN is blocked — use your backup key, then remove the blocked one in Settings.",
    );
  });

  it("with a single key, a blocked PIN doesn't mention a backup", async () => {
    const user = userEvent.setup();
    locked({ keys: [makeKey({ nickname: "Primary" })], singleKeyWarning: true }).failOnce("unlock", "authn.pinBlocked");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Unlock" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("PIN blocked");
    expect(alert).not.toHaveTextContent("backup");
  });

  it("can try again after an error", async () => {
    const user = userEvent.setup();
    const ipc = locked().failOnce("unlock", "authn.timeout").on("unlock", makeStatus({ phase: "unlocked", keys }));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Timed out");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => {
      expect(ipc.callsTo("unlock")).toHaveLength(2);
    });
  });

  it("shows the Windows Security step while unlocking; Cancel closes the prompt without an error", async () => {
    const user = userEvent.setup();
    let fail: (reason: unknown) => void = () => undefined;
    const ipc = locked()
      .on("unlock", () => new Promise<AppStatus>((_, reject) => (fail = reject)))
      .on("cancel_prompt", () => {
        fail(wireError("authn.cancelled", "the operation was cancelled"));
        return null;
      });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Unlock" }));

    const overlay = await screen.findByRole("dialog");
    await ipc.emit("key-step", { step: "useEnrolledKey", nickname: null });
    expect(await within(overlay).findByText("Confirm with your YubiKey")).toBeInTheDocument();
    expect(overlay).toHaveTextContent("Use Primary or Backup.");
    expect(overlay).toHaveTextContent(/PIN or.*fingerprint.*then touch/);
    // Behind the modal overlay (hidden from assistive tech while it's up), and disabled.
    expect(screen.getByRole("button", { name: "Unlock", hidden: true })).toBeDisabled();

    await user.click(within(overlay).getByRole("button", { name: "Cancel" }));
    expect(ipc.callsTo("cancel_prompt")).toHaveLength(1);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeEnabled();
  });

  it("Esc in the prompt overlay cancels the prompt", async () => {
    const user = userEvent.setup();
    const ipc = locked().on("unlock", () => new Promise<AppStatus>(() => undefined));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Unlock" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(ipc.callsTo("cancel_prompt")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeInTheDocument();
  });

  it.each([
    ["manual", "You locked efre."],
    ["idle", "Locked after a while without activity (auto-lock)."],
    ["suspend", "Locked because your PC went to sleep."],
    ["session", "Locked because Windows was locked, or you switched users or signed out."],
    ["unplug", "Locked because no YubiKey was plugged in."],
  ] as const)("says why it locked: %s", async (reason, text) => {
    locked({ lastLockReason: reason });
    render(<App />);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("shows no lock reason on a fresh start", async () => {
    locked();
    render(<App />);
    await screen.findByRole("heading", { name: HEADING });
    expect(screen.queryByText(/^Locked|You locked/)).not.toBeInTheDocument();
  });
});

describe("UnsupportedScreen", () => {
  it("asks to update Windows when the WebAuthn API is missing", async () => {
    mockIpc().on(
      "app_status",
      makeStatus({
        phase: "unsupported",
        apiVersion: null,
        unsupportedReason: "This version of Windows is too old for efre. Install the latest Windows updates.",
      }),
    );
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Update Windows to use efre" })).toBeInTheDocument();
    expect(screen.getByText(/too old for efre/)).toBeInTheDocument();
    expect(screen.getByText(/Not available on this PC/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("names the API version this PC has", async () => {
    mockIpc().on("app_status", makeStatus({ phase: "unsupported", apiVersion: 3, unsupportedReason: null }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Update Windows to use efre" })).toBeInTheDocument();
    expect(screen.getByText(/This PC has version 3/)).toBeInTheDocument();
  });

  it("shows other blocking problems, such as a vault it can't open", async () => {
    const user = userEvent.setup();
    const ipc = mockIpc()
      .on(
        "app_status",
        makeStatus({ phase: "unsupported", apiVersion: 9, unsupportedReason: "efre can't open the vault file: it is in use." }),
      )
      .on("open_vault_folder", null);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "efre can't open your vault" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open vault folder" }));
    expect(ipc.callsTo("open_vault_folder")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(ipc.callsTo("app_status").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("classifies the backend's reasons", () => {
    const of = (unsupportedReason: string | null, apiVersion: number | null = null) =>
      classifyUnsupported({ unsupportedReason, apiVersion });
    expect(of(null)).toBe("windows");
    expect(of("Windows' security key API is version 3 here; efre needs version 4 or later (hmac-secret).", 3)).toBe(
      "windows",
    );
    expect(of("efre could not start Windows' security key support (x). Restart efre, or update Windows.")).toBe(
      "windows",
    );
    expect(of("efre can't open the vault file: the file is damaged", 9)).toBe("vault");
    expect(of("efre is closing.", 9)).toBe("other");
  });
});
