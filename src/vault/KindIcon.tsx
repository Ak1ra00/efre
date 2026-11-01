import type { ItemKind } from "@/lib/ipc-types";
import { ITEM_KINDS } from "@/lib/items";
import { cn } from "@/lib/utils";

/** The item kind's icon on a small tile (list rows, detail and editor headers). */
export function KindIcon({
  kind,
  size = "md",
  active = false,
  className,
}: {
  kind: ItemKind;
  size?: "md" | "lg";
  active?: boolean;
  className?: string;
}) {
  const Icon = ITEM_KINDS[kind].icon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center border border-line bg-elevated shadow-highlight transition-colors duration-150",
        size === "lg" ? "size-12 rounded-xl" : "size-8 rounded-lg",
        active ? "text-accent-text" : "text-fg-muted",
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-6" : "size-4"} />
    </span>
  );
}
