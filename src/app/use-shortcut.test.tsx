import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { type ShortcutOptions, useShortcut } from "./use-shortcut";

function Harness({
  combo,
  onFire,
  options,
}: {
  combo: string | string[];
  onFire: (e: KeyboardEvent) => void;
  options?: ShortcutOptions;
}) {
  useShortcut(combo, onFire, options);
  return (
    <div>
      <input aria-label="Search" />
      <input aria-label="Remember" type="checkbox" />
      <button type="button">Other</button>
    </div>
  );
}

describe("useShortcut", () => {
  it("fires on its combo and prevents the browser default", async () => {
    const user = userEvent.setup();
    const onFire = vi.fn((e: KeyboardEvent) => e.defaultPrevented);
    render(<Harness combo="Ctrl+K" onFire={onFire} />);

    await user.keyboard("{Control>}k{/Control}");
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.results[0]?.value).toBe(true);

    await user.keyboard("k");
    await user.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("ignores typing in text fields unless allowInInputs", async () => {
    const user = userEvent.setup();
    const help = vi.fn();
    const palette = vi.fn();
    function Both() {
      useShortcut("?", help);
      useShortcut("Ctrl+K", palette, { allowInInputs: true });
      return <input aria-label="Search" />;
    }
    render(<Both />);

    await user.click(screen.getByLabelText("Search"));
    await user.keyboard("?");
    expect(help).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Search")).toHaveValue("?");

    await user.keyboard("{Control>}k{/Control}");
    expect(palette).toHaveBeenCalledTimes(1);

    await user.click(document.body);
    await user.keyboard("?");
    expect(help).toHaveBeenCalledTimes(1);
  });

  it("still fires from non-text inputs such as checkboxes", async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    render(<Harness combo="?" onFire={onFire} />);
    await user.click(screen.getByLabelText("Remember"));
    await user.keyboard("?");
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("respects enabled, accepts several combos, skips handled events", async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    const { rerender } = render(<Harness combo={["Delete", "Ctrl+D"]} onFire={onFire} options={{ enabled: false }} />);
    await user.keyboard("{Delete}");
    expect(onFire).not.toHaveBeenCalled();

    rerender(<Harness combo={["Delete", "Ctrl+D"]} onFire={onFire} />);
    await user.keyboard("{Delete}");
    await user.keyboard("{Control>}d{/Control}");
    expect(onFire).toHaveBeenCalledTimes(2);

    // Something else (e.g. a dialog closing on Esc) already handled the key.
    const handled = new KeyboardEvent("keydown", { key: "Delete", cancelable: true, bubbles: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(onFire).toHaveBeenCalledTimes(2);
  });

  it("calls the latest handler without re-subscribing", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const add = vi.spyOn(window, "addEventListener");
    const { rerender } = render(<Harness combo="Ctrl+L" onFire={first} />);
    const subscriptions = add.mock.calls.filter(([type]) => type === "keydown").length;
    rerender(<Harness combo="Ctrl+L" onFire={second} />);
    await user.keyboard("{Control>}l{/Control}");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.filter(([type]) => type === "keydown").length).toBe(subscriptions);
  });

  it("ignores key repeat unless allowRepeat", () => {
    const onFire = vi.fn();
    render(<Harness combo="Ctrl+L" onFire={onFire} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", ctrlKey: true, repeat: true }));
    expect(onFire).not.toHaveBeenCalled();
  });
});
