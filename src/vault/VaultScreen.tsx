/**
 * PLACEHOLDER (E0). Owned by E2: replace freely, keep this path and export name.
 * Shown when phase === "unlocked", below the single-key banner, filling the window.
 * The real screen: sidebar → virtualized list → detail, search, trash.
 */
import { Inbox } from "lucide-react";
import { useEffect, useState } from "react";

import { toastError } from "@/app/toast-error";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { ipc } from "@/lib/ipc";
import type { ItemMeta } from "@/lib/ipc-types";

export function VaultScreen() {
  const [items, setItems] = useState<ItemMeta[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    ipc.listItems().then(
      (list) => {
        if (!cancelled) setItems(list.filter((item) => item.trashedAt === null));
      },
      (err: unknown) => {
        if (!cancelled) toastError(err, "Couldn't load your items");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (items === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading items" className="text-fg-subtle" />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={Inbox} title="No items yet" description="Items you add appear here." />
      </div>
    );
  }
  return (
    <main className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-base font-semibold">Vault</h1>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id} className="rounded-md px-3 py-2 hover:bg-hover">
            <span className="font-medium">{item.title}</span>
            {item.username === null ? null : <span className="ml-2 text-fg-subtle">{item.username}</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
