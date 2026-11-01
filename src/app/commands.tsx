/**
 * Command registry: features register what the user can do; the Ctrl+K palette and the
 * shortcut sheet list it. Registering does NOT bind the shortcut: `shortcut` is for
 * display, bind it with `useShortcut`.
 *
 *   useRegisterCommands([
 *     { id: "item.new-login", title: "New login", group: "New", shortcut: "Ctrl+N", run: newLogin },
 *   ]);
 *
 * Commands may be re-created on every render; `run` always calls the latest one.
 */
import type { LucideIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  use,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";

export interface Command {
  /** Unique and stable, namespaced by feature: "item.copy-password", "app.lock". */
  id: string;
  title: string;
  /** One of COMMAND_GROUPS (other names are listed after them). */
  group: string;
  /** Extra search terms for the palette. */
  keywords?: readonly string[];
  /** Display only, Windows notation ("Ctrl+N"). */
  shortcut?: string;
  icon?: LucideIcon;
  /** false = not available right now (the palette hides it). Default true. */
  enabled?: boolean;
  run: () => void | Promise<void>;
}

/** Palette order. "Item" acts on the selected item; "Vault" on the whole vault. */
export const COMMAND_GROUPS = ["Item", "New", "Go to", "Vault", "Settings", "Help"] as const;

function shapeOf(commands: readonly Command[]): string {
  return JSON.stringify(
    commands.map((c) => [c.id, c.title, c.group, c.keywords ?? [], c.shortcut ?? "", c.enabled !== false]),
  );
}

function groupRank(group: string): number {
  const index = (COMMAND_GROUPS as readonly string[]).indexOf(group);
  return index === -1 ? COMMAND_GROUPS.length : index;
}

export class CommandRegistry {
  private readonly owners = new Map<string, readonly Command[]>();
  private readonly shapes = new Map<string, string>();
  private readonly icons = new Map<string, readonly (LucideIcon | undefined)[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly Command[] = [];

  /** Replaces `owner`'s commands. Listeners are notified only if something visible changed. */
  set(owner: string, commands: readonly Command[]): void {
    this.owners.set(owner, commands);
    const shape = shapeOf(commands);
    const icons = commands.map((c) => c.icon);
    const previousIcons = this.icons.get(owner);
    const iconsSame =
      previousIcons?.length === icons.length && previousIcons.every((icon, i) => icon === icons[i]);
    if (this.shapes.get(owner) === shape && iconsSame) return;
    this.shapes.set(owner, shape);
    this.icons.set(owner, icons);
    this.rebuild();
  }

  remove(owner: string): void {
    if (!this.owners.delete(owner)) return;
    this.shapes.delete(owner);
    this.icons.delete(owner);
    this.rebuild();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): readonly Command[] => this.snapshot;

  private runLatest(owner: string, id: string): void | Promise<void> {
    const command = this.owners.get(owner)?.find((c) => c.id === id);
    if (command === undefined || command.enabled === false) return;
    return command.run();
  }

  private rebuild(): void {
    const byId = new Map<string, Command>();
    for (const [owner, commands] of this.owners) {
      for (const command of commands) {
        if (import.meta.env.DEV && byId.has(command.id)) {
          console.warn(`efre: command "${command.id}" is registered twice; the last one wins`);
        }
        byId.delete(command.id);
        byId.set(command.id, { ...command, run: () => this.runLatest(owner, command.id) });
      }
    }
    // Stable sort: group order first, then registration order.
    this.snapshot = [...byId.values()].sort((a, b) => groupRank(a.group) - groupRank(b.group));
    for (const listener of this.listeners) listener();
  }
}

const RegistryContext = createContext<CommandRegistry | null>(null);

export function CommandRegistryProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new CommandRegistry());
  return <RegistryContext value={registry}>{children}</RegistryContext>;
}

function useRegistry(): CommandRegistry {
  const registry = use(RegistryContext);
  if (registry === null) throw new Error("Commands need a <CommandRegistryProvider>");
  return registry;
}

/** Registers `commands` while the calling component is mounted. */
export function useRegisterCommands(commands: readonly Command[]): void {
  const registry = useRegistry();
  const owner = useId();
  // Every render: keeps `run` fresh; listeners only hear about visible changes.
  useLayoutEffect(() => {
    registry.set(owner, commands);
  });
  useLayoutEffect(
    () => () => {
      registry.remove(owner);
    },
    [registry, owner],
  );
}

/** Every registered command (including disabled ones), in palette order. */
export function useCommands(): readonly Command[] {
  const registry = useRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}
