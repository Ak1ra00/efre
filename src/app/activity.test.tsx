import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { mockIpc } from "@/test/ipc-mock";

import { ACTIVITY_THROTTLE_MS, createActivityThrottle, useActivityPinger } from "./activity";

describe("activity throttle", () => {
  it("pings on the leading edge, then at most once per interval", () => {
    let t = 1_000;
    const ping = vi.fn();
    const onInput = createActivityThrottle(ping, () => t);

    onInput();
    onInput();
    expect(ping).toHaveBeenCalledTimes(1);

    t += ACTIVITY_THROTTLE_MS - 1;
    onInput();
    expect(ping).toHaveBeenCalledTimes(1);

    t += 1;
    onInput();
    expect(ping).toHaveBeenCalledTimes(2);

    t += 60_000;
    onInput();
    onInput();
    expect(ping).toHaveBeenCalledTimes(3);
  });
});

describe("useActivityPinger", () => {
  function Pinger({ enabled }: { enabled: boolean }) {
    useActivityPinger(enabled);
    return null;
  }

  it("sends `activity` on pointer, keyboard and wheel input, throttled", async () => {
    const ipc = mockIpc();
    let now = 50_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    render(<Pinger enabled />);

    fireEvent.pointerMove(window);
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.wheel(window);
    await vi.waitFor(() => {
      expect(ipc.callsTo("activity")).toHaveLength(1);
    });

    now += ACTIVITY_THROTTLE_MS;
    fireEvent.keyDown(window, { key: "b" });
    await vi.waitFor(() => {
      expect(ipc.callsTo("activity")).toHaveLength(2);
    });
  });

  it("stays silent while disabled (vault locked) and survives a failing ping", async () => {
    const ipc = mockIpc().fail("activity", "locked");
    const { rerender } = render(<Pinger enabled={false} />);
    fireEvent.pointerDown(window);
    expect(ipc.callsTo("activity")).toHaveLength(0);

    rerender(<Pinger enabled />);
    fireEvent.pointerDown(window);
    await vi.waitFor(() => {
      expect(ipc.callsTo("activity")).toHaveLength(1);
    });
  });
});
