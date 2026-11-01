import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Toaster } from "./toast";
import { clearToasts, TOAST_LIMIT, toast, useToast } from "./use-toast";

describe("toasts", () => {
  it("shows a toast with an Undo action that runs once and closes the toast", async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    render(<Toaster />);

    act(() => {
      toast({ title: "Moved to trash", description: "GitHub", action: { label: "Undo", onClick: undo } });
    });
    expect(await screen.findByText("Moved to trash")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(screen.queryByText("Moved to trash")).not.toBeInTheDocument();
    });
  });

  it("can be dismissed and updated through its handle", async () => {
    render(<Toaster />);
    let handle: ReturnType<typeof toast> | undefined;
    act(() => {
      handle = toast({ title: "Copying…" });
    });
    act(() => {
      handle?.update({ title: "Copied", variant: "success" });
    });
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    act(() => {
      handle?.dismiss();
    });
    await vi.waitFor(() => {
      expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    });
  });

  it(`keeps at most ${String(TOAST_LIMIT)} open and clears everything on lock`, () => {
    let open = 0;
    function Count() {
      open = useToast().toasts.filter((t) => t.open).length;
      return null;
    }
    render(<Count />);
    act(() => {
      for (let i = 0; i < 5; i++) toast({ title: `Toast ${String(i)}` });
    });
    expect(open).toBe(TOAST_LIMIT);
    act(() => {
      clearToasts();
    });
    expect(open).toBe(0);
  });
});
