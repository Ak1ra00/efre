/**
 * Shared plumbing for the dev mock backend and the Vitest helper: installs Tauri's IPC
 * mock and emulates its event plugin (listen / unlisten / emit), so `listenEvent` works
 * without Rust. Never imported by app code (ESLint enforces it).
 *
 * We emulate events ourselves instead of `mockIPC(…, { shouldMockEvents: true })`:
 * @tauri-apps/api 2.12's mock forgets listeners on unlisten (it reads `id`, the API
 * sends `eventId`) and then warns on every later emit.
 */
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";

import type { EventName, IpcErrorPayload, IpcEvents } from "@/lib/ipc-types";

export type RawHandler = (cmd: string, args: Record<string, unknown>) => unknown;

export interface MockIpc {
  /** Delivers an event to every current listener, synchronously. */
  emit: <E extends EventName>(event: E, payload: IpcEvents[E]) => void;
  listenerCount: (event: EventName) => number;
  uninstall: () => void;
}

interface TauriInternals {
  runCallback?: (id: number, data: unknown) => void;
}

function runCallback(id: number, data: unknown) {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  internals?.runCallback?.(id, data);
}

/** What Tauri rejects a command with: the serialized IpcError. */
export function wireError(code: string, message: string): IpcErrorPayload {
  return { code, message };
}

export function installMockIpc(handle: RawHandler): MockIpc {
  const listeners = new Map<string, Set<number>>();

  const emit = (event: string, payload: unknown) => {
    for (const id of [...(listeners.get(event) ?? [])]) runCallback(id, { event, id, payload });
  };

  mockWindows("main");
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "plugin:event|listen": {
        const event = String(args["event"]);
        const handler = Number(args["handler"]);
        const set = listeners.get(event) ?? new Set<number>();
        set.add(handler);
        listeners.set(event, set);
        return handler;
      }
      case "plugin:event|unlisten":
        listeners.get(String(args["event"]))?.delete(Number(args["eventId"]));
        return null;
      case "plugin:event|emit":
        emit(String(args["event"]), args["payload"]);
        return null;
      default:
        return handle(cmd, args);
    }
  });

  return {
    emit,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
    uninstall: () => {
      listeners.clear();
      clearMocks();
    },
  };
}
