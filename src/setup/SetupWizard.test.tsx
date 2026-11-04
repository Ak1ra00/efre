import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "@/app/App";
import { wireError } from "@/dev/mock-ipc";
import type { KeyInfo } from "@/lib/ipc-types";
import { makeKey, makeStatus } from "@/test/fixtures";
import { mockIpc } from "@/test/ipc-mock";

const primary = makeKey({ nickname: "Primary" });
const backup = makeKey({ nickname: "Backup" });

/** A command that stays pending until the test settles it. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SetupWizard", () => {
  it("walks welcome → how it works → primary → backup → done and enrolls two keys", async () => {
    const user = userEvent.setup();
    const ipc = mockIpc()
      .on("app_status", makeStatus({ phase: "setup" }))
      .on("setup_start", makeStatus({ phase: "setup" }))
      .once("setup_enroll_key", primary)
      .once("setup_enroll_key", backup)
      .on("setup_finish", makeStatus({ phase: "unlocked", keys: [primary, backup] }))
      .on("list_items", []);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to efre" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Get started" }));
    expect(await screen.findByRole("heading", { name: "How efre works" })).toBeInTheDocument();
    expect(screen.getByText(/only recovery/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enroll my first key" }));

    expect(await screen.findByRole("heading", { name: "Enroll your primary key" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Nickname" })).toHaveValue("Primary");
    await user.click(screen.getByRole("button", { name: "Enroll key" }));

    expect(await screen.findByRole("heading", { name: "Enroll your backup key" })).toBeInTheDocument();
    expect(screen.getByText("Primary is enrolled")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Nickname" })).toHaveValue("Backup");
    await user.click(screen.getByRole("button", { name: "Enroll backup key" }));

    expect(await screen.findByRole("heading", { name: "Your vault is ready" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Enrolled keys" });
    expect(within(list).getByText("Primary")).toBeInTheDocument();
    expect(within(list).getByText("Backup")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open my vault" }));

    await waitFor(() => {
      expect(ipc.callsTo("setup_finish")).toHaveLength(1);
    });
    expect(ipc.calls.map((c) => c.cmd).filter((cmd) => cmd.startsWith("setup_"))).toEqual([
      "setup_start",
      "setup_enroll_key",
      "setup_enroll_key",
      "setup_finish",
    ]);
    expect(ipc.callsTo("setup_enroll_key")).toEqual([{ nickname: "Primary" }, { nickname: "Backup" }]);
    // The vault is open: the wizard is gone.
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Your vault is ready" })).not.toBeInTheDocument();
    });
  });

  it("allows adding the backup later only after the warning is acknowledged", async () => {
    const user = userEvent.setup();
    const ipc = mockIpc()
      .on("app_status", makeStatus({ phase: "setup", setupKeys: [primary] }))
      .on("setup_finish", makeStatus({ phase: "unlocked", keys: [primary] }))
      .on("list_items", []);
    render(<App />);

    // A wizard with one key already enrolled resumes at the backup step.
    expect(await screen.findByRole("heading", { name: "Enroll your backup key" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add backup later" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Continue with only one key?" });
    expect(dialog).toHaveTextContent("no password and no recovery code");
    const proceed = within(dialog).getByRole("button", { name: "Continue with one key" });
    expect(proceed).toBeDisabled();
    await user.click(proceed);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("checkbox", { name: /nothing can open my vault/ }));
    expect(proceed).toBeEnabled();
    await user.click(proceed);

    expect(await screen.findByRole("heading", { name: "Your vault is ready" })).toBeInTheDocument();
    expect(screen.getByText("Add a backup key soon")).toBeInTheDocument();
    expect(ipc.callsTo("setup_enroll_key")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Open my vault" }));
    await waitFor(() => {
      expect(ipc.callsTo("setup_finish")).toHaveLength(1);
    });
  });

  it("goes back to enrolling when the warning is declined", async () => {
    const user = userEvent.setup();
    mockIpc().on("app_status", makeStatus({ phase: "setup", setupKeys: [primary] }));
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Add backup later" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Enroll a backup now" }));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Enroll your backup key" })).toBeInTheDocument();
  });

  it("says what Windows asks for at each prompt, and Cancel closes the prompt quietly", async () => {
    const user = userEvent.setup();
    const enroll = deferred<KeyInfo>();
    const ipc = mockIpc()
      .on("app_status", makeStatus({ phase: "setup", setupKeys: [primary] }))
      .on("setup_enroll_key", () => enroll.promise)
      .on("cancel_prompt", () => {
        enroll.reject(wireError("authn.cancelled", "the operation was cancelled"));
        return null;
      });
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Enroll backup key" }));

    const overlay = await screen.findByRole("dialog", { name: "Waiting for Windows Security…" });
    await ipc.emit("key-step", { step: "createCredential", nickname: null });
    expect(await within(overlay).findByText("Insert the new YubiKey")).toBeInTheDocument();
    expect(overlay).toHaveTextContent("Step 1 of 2");
    expect(overlay).toHaveTextContent("fingerprint");
    expect(overlay).toHaveTextContent(/swapping keys in the same USB port is fine/i);

    await ipc.emit("key-step", { step: "confirmNewKey", nickname: null });
    expect(await within(overlay).findByText("Touch the new key again")).toBeInTheDocument();
    expect(overlay).toHaveTextContent("Step 2 of 2");
    expect(overlay).toHaveTextContent("Same key again: keep it plugged in.");

    await user.click(within(overlay).getByRole("button", { name: "Cancel" }));
    expect(ipc.callsTo("cancel_prompt")).toHaveLength(1);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    // The user cancelled on purpose: no error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Enroll your backup key" })).toBeInTheDocument();
  });

  it.each([
    ["authn.alreadyEnrolled", "This key is already enrolled", /Insert your other key/],
    ["authn.pinNotSet", "Set a PIN on this key first", /Sign-in options › Security key/],
    ["authn.unsupportedPlatform", "Update Windows", /latest Windows updates/],
    ["authn.attestationRejected", "Only YubiKeys are accepted", /genuine YubiKey/],
    ["authn.cancelled", "Enrollment cancelled", /keep the same key plugged in/],
    ["authn.timeout", "Timed out", /touch the key/],
  ] as const)("explains %s", async (code, title, detail) => {
    const user = userEvent.setup();
    mockIpc()
      .on("app_status", makeStatus({ phase: "setup", setupKeys: [primary] }))
      .failOnce("setup_enroll_key", code);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Enroll backup key" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(title);
    expect(alert).toHaveTextContent(detail);
  });

  it("starts over with setup_cancel after a confirmation", async () => {
    const user = userEvent.setup();
    const ipc = mockIpc()
      .on("app_status", makeStatus({ phase: "setup", setupKeys: [primary] }))
      .on("setup_cancel", makeStatus({ phase: "setup" }))
      .on("setup_start", makeStatus({ phase: "setup" }))
      .on("setup_enroll_key", primary);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Start over" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Start over?" });
    await user.click(within(dialog).getByRole("button", { name: "Start over" }));

    expect(await screen.findByRole("heading", { name: "Enroll your primary key" })).toBeInTheDocument();
    expect(ipc.callsTo("setup_cancel")).toHaveLength(1);
    // A new run starts with setup_start again.
    await user.click(screen.getByRole("button", { name: "Enroll key" }));
    await waitFor(() => {
      expect(ipc.callsTo("setup_enroll_key")).toHaveLength(1);
    });
    expect(ipc.callsTo("setup_start")).toHaveLength(1);
  });

  it("validates the nickname inline", async () => {
    const user = userEvent.setup();
    const ipc = mockIpc().on("app_status", makeStatus({ phase: "setup", setupKeys: [primary] }));
    render(<App />);
    const nickname = await screen.findByRole("textbox", { name: "Nickname" });
    await user.clear(nickname);
    await user.type(nickname, "primary");
    await user.click(screen.getByRole("button", { name: "Enroll backup key" }));
    expect(nickname).toHaveAccessibleDescription(/Another key is already called/);
    expect(ipc.callsTo("setup_enroll_key")).toHaveLength(0);
  });
});
