/**
 * Vitest helper: script command responses and emit Rust events, without Tauri.
 *
 *   const ipc = mockIpc()
 *     .on("app_status", makeStatus({ phase: "locked" }))
 *     .on("get_item", ({ id }) => makeItemView({ id }))
 *     .failOnce("unlock", "authn.cancelled");
 *   render(<App />);
 *   await ipc.emit("locked", { reason: "idle" });
 *   expect(ipc.callsTo("unlock")).toHaveLength(1);
 *
 * Unscripted commands reject with `internal` and are listed in `unhandled`.
 * `activity` and `cancel_prompt` resolve with null by default. Cleanup is automatic.
 */
import { act } from "@testing-library/react";

import { installMockIpc, wireError } from "@/dev/mock-ipc";
import type {
  CommandArgs,
  CommandName,
  CommandResult,
  EventName,
  IpcErrorCode,
  IpcErrorPayload,
  IpcEvents,
} from "@/lib/ipc-types";

export type Responder<C extends CommandName> =
  | CommandResult<C>
  | ((args: CommandArgs<C>) => CommandResult<C> | Promise<CommandResult<C>>);

export interface IpcCall {
  cmd: string;
  args: Record<string, unknown>;
}

export interface IpcMock {
  /** Every call to `cmd` resolves with `response` (a value, or a function of the args). */
  on: <C extends CommandName>(cmd: C, response: Responder<C>) => IpcMock;
  /** The next call to `cmd` only; queued responses run first, in order. */
  once: <C extends CommandName>(cmd: C, response: Responder<C>) => IpcMock;
  /** Every call to `cmd` rejects with this code. */
  fail: (cmd: CommandName, code: IpcErrorCode, message?: string) => IpcMock;
  /** The next call to `cmd` rejects with this code. */
  failOnce: (cmd: CommandName, code: IpcErrorCode, message?: string) => IpcMock;
  /** Every call so far, in order. */
  readonly calls: readonly IpcCall[];
  /** The arguments of every call to `cmd`. */
  callsTo: <C extends CommandName>(cmd: C) => CommandArgs<C>[];
  /** Commands called without a scripted response. */
  readonly unhandled: readonly string[];
  /** Emits a Rust → webview event (inside act()). */
  emit: <E extends EventName>(event: E, payload: IpcEvents[E]) => Promise<void>;
  listenerCount: (event: EventName) => number;
}

type AnyResponder = (args: Record<string, unknown>) => unknown;

class Rejection {
  constructor(readonly payload: IpcErrorPayload) {}
}

function toResponder(response: unknown): AnyResponder {
  return typeof response === "function" ? (response as AnyResponder) : () => response;
}

/** Tauri rejects a failed command with the plain serialized error, not an Error instance. */
function rejectLikeTauri(payload: IpcErrorPayload): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
  return Promise.reject(payload);
}

export function mockIpc(): IpcMock {
  const persistent = new Map<string, AnyResponder>([
    ["activity", () => null],
    ["cancel_prompt", () => null],
  ]);
  const queued = new Map<string, AnyResponder[]>();
  const calls: IpcCall[] = [];
  const unhandled: string[] = [];

  const core = installMockIpc(async (cmd, args) => {
    calls.push({ cmd, args });
    const responder = queued.get(cmd)?.shift() ?? persistent.get(cmd);
    if (responder === undefined) {
      unhandled.push(cmd);
      return rejectLikeTauri(wireError("internal", `ipc-mock: no response scripted for "${cmd}"`));
    }
    const result = await responder(args);
    return result instanceof Rejection ? rejectLikeTauri(result.payload) : result;
  });

  const mock: IpcMock = {
    on: (cmd, response) => {
      persistent.set(cmd, toResponder(response));
      return mock;
    },
    once: (cmd, response) => {
      const list = queued.get(cmd) ?? [];
      list.push(toResponder(response));
      queued.set(cmd, list);
      return mock;
    },
    fail: (cmd, code, message = code) => {
      persistent.set(cmd, () => new Rejection(wireError(code, message)));
      return mock;
    },
    failOnce: (cmd, code, message = code) => {
      const list = queued.get(cmd) ?? [];
      list.push(() => new Rejection(wireError(code, message)));
      queued.set(cmd, list);
      return mock;
    },
    calls,
    callsTo: <C extends CommandName>(cmd: C) =>
      calls.filter((c) => c.cmd === cmd).map((c) => c.args as unknown as CommandArgs<C>),
    unhandled,
    emit: async (event, payload) => {
      await act(async () => {
        core.emit(event, payload);
        await Promise.resolve();
      });
    },
    listenerCount: core.listenerCount,
  };
  return mock;
}
