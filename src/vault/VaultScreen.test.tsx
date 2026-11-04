import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppStatusProvider } from "@/app/app-status";
import { CommandRegistryProvider, useCommands } from "@/app/commands";
import { UIStateProvider, useUIState } from "@/app/ui-state";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ItemDraft, ItemMeta, ItemView } from "@/lib/ipc-types";
import { makeItemMeta, makeItemView, makeStatus } from "@/test/fixtures";
import { type IpcMock, mockIpc } from "@/test/ipc-mock";

import { VaultScreen } from "./VaultScreen";

/** Window width as matchMedia sees it (jsdom has no layout). */
function setViewport(width: number) {
  const matchMedia = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min !== null && width >= Number(min[1]),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
}

/** Stands in for E3's generator dialog: "Use" hands a value back to the editor. */
function GeneratorStub() {
  const { generatorOpen, generatorOnUse, closeGenerator } = useUIState();
  if (!generatorOpen) return null;
  return (
    <button
      type="button"
      onClick={() => {
        generatorOnUse?.("Gen3rated!");
        closeGenerator();
      }}
    >
      Use generated
    </button>
  );
}

function CommandList() {
  const commands = useCommands();
  return (
    <ul aria-label="Registered commands">
      {commands.map((c) => (
        <li key={c.id} data-enabled={c.enabled !== false}>
          {c.title}
        </li>
      ))}
    </ul>
  );
}

function renderVault() {
  return render(
    <TooltipProvider>
      <AppStatusProvider>
        <UIStateProvider>
          <CommandRegistryProvider>
            <VaultScreen />
            <GeneratorStub />
            <CommandList />
          </CommandRegistryProvider>
        </UIStateProvider>
      </AppStatusProvider>
      <Toaster />
    </TooltipProvider>,
  );
}

const DAY = 86_400;
const T0 = 1_760_000_000;

function vault(items: ItemMeta[], views: ItemView[] = []): IpcMock {
  const byId = new Map(views.map((v) => [v.meta.id, v]));
  let list = [...items];
  return mockIpc()
    .on("app_status", makeStatus({ phase: "unlocked" }))
    .on("list_items", () => list)
    .on("get_item", ({ id }) => {
      const view = byId.get(id);
      const meta = list.find((m) => m.id === id);
      if (view !== undefined) return { ...view, meta: meta ?? view.meta };
      return makeItemView(meta ?? { id });
    })
    .on("copy_field", { clearsInSeconds: 30 })
    .on("copy_role", { clearsInSeconds: 30 })
    .on("trash_item", ({ id }) => {
      list = list.map((m) => (m.id === id ? { ...m, trashedAt: T0 + 5 * DAY } : m));
      return list.find((m) => m.id === id) ?? makeItemMeta({ id });
    })
    .on("restore_item", ({ id }) => {
      list = list.map((m) => (m.id === id ? { ...m, trashedAt: null } : m));
      return list.find((m) => m.id === id) ?? makeItemMeta({ id });
    })
    .on("delete_item", ({ id }) => {
      list = list.filter((m) => m.id !== id);
      return null;
    })
    .on("set_favorite", ({ id, favorite }) => {
      list = list.map((m) => (m.id === id ? { ...m, favorite } : m));
      return list.find((m) => m.id === id) ?? makeItemMeta({ id });
    });
}

const github = makeItemMeta({ title: "GitHub", username: "octocat", tags: ["dev"], updatedAt: T0 + 3 * DAY });
const bank = makeItemMeta({ title: "Northwind Bank", username: "40812233", tags: ["finance"], updatedAt: T0 + 9 * DAY });
const note = makeItemMeta({
  title: "Emergency plan",
  kind: "secureNote",
  username: null,
  hasPassword: false,
  updatedAt: T0 + 1 * DAY,
});
const dropbox = makeItemMeta({ title: "Dropbox (old)", trashedAt: T0 + 2 * DAY });
const ITEMS = [github, bank, note, dropbox];

const githubView = makeItemView(github);
const noteView = makeItemView(note, [
  { id: 1, label: "Note", kind: "multiline", role: "notes", value: "# Plan\n\n<b>raw</b> [docs](https://example.com) ![x](https://example.com/x.png)" },
]);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const optionTitles = () => screen.getAllByRole("option").map((o) => o.getAttribute("aria-label")?.split(", ")[0]);
const option = (title: string) => screen.getByRole("option", { name: new RegExp(`^${escape(title)},`) });
const search = () => screen.getByRole("combobox", { name: /^Search/ });

/** user-event's clipboard stub, spied on to show that nothing in the vault writes to it. */
// eslint-disable-next-line no-restricted-properties -- the test asserts the JS clipboard is never used
const jsClipboard = () => navigator.clipboard;

async function openItem(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${escape(title)},`) }));
  return screen.findByRole("region", { name: title });
}

beforeEach(() => {
  setViewport(1280);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("vault list", () => {
  it("shows the view's items A–Z, searches fuzzily (best match selected) and sorts", async () => {
    const user = userEvent.setup();
    vault(ITEMS, [githubView]);
    renderVault();
    await screen.findByRole("listbox", { name: "All items" });
    expect(optionTitles()).toEqual(["Emergency plan", "GitHub", "Northwind Bank"]);

    await user.click(search());
    await user.keyboard("nwb");
    expect(optionTitles()).toEqual(["Northwind Bank"]);
    expect(option("Northwind Bank")).toHaveAttribute("aria-selected", "true");

    await user.clear(search());
    await user.keyboard("octo");
    expect(optionTitles()).toEqual(["GitHub"]);
    await user.clear(search());

    await user.click(screen.getByRole("button", { name: /^Sort:/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Recently updated" }));
    expect(optionTitles()).toEqual(["Northwind Bank", "GitHub", "Emergency plan"]);
  });

  it("moves through the list with the keyboard and opens with Enter", async () => {
    const user = userEvent.setup();
    vault(ITEMS, [githubView]);
    renderVault();
    const list = await screen.findByRole("listbox", { name: "All items" });
    list.focus();
    await waitFor(() => {
      expect(option("Emergency plan")).toHaveAttribute("aria-selected", "true");
    });
    await user.keyboard("{ArrowDown}");
    expect(option("GitHub")).toHaveAttribute("aria-selected", "true");
    expect(list).toHaveAttribute("aria-activedescendant", option("GitHub").id);
    await user.keyboard("{End}");
    expect(option("Northwind Bank")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}{ArrowDown}{Enter}");
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "GitHub" })).toHaveFocus();
    });
  });

  it("filters by sidebar view and shows thoughtful empty states", async () => {
    const user = userEvent.setup();
    vault([github, note]);
    renderVault();
    await screen.findByRole("listbox", { name: "All items" });

    await user.click(screen.getByRole("button", { name: /^Secure notes/ }));
    expect(optionTitles()).toEqual(["Emergency plan"]);

    await user.click(screen.getByRole("button", { name: /^Cards/ }));
    expect(await screen.findByText("No cards yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Trash/ }));
    expect(await screen.findByText("Trash is empty")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^All items/ }));
    await user.click(search());
    await user.keyboard("zzqx");
    expect(await screen.findByText("No results for “zzqx”")).toBeInTheDocument();
    // The empty state offers it too, next to the search field's own clear button.
    expect(screen.getAllByRole("button", { name: "Clear search" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Clear search" })[1] ?? document.body);
    expect(optionTitles()).toEqual(["Emergency plan", "GitHub"]);
  });

  it("invites you to add the first item when the vault is empty", async () => {
    const user = userEvent.setup();
    vault([]);
    renderVault();
    expect(await screen.findByText("Your vault is empty")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Secure Note" }));
    expect(await screen.findByRole("heading", { name: "New secure note" })).toBeInTheDocument();
  });
});

describe("item detail", () => {
  it("reveals a hidden field from Rust and hides it again after 10 s", async () => {
    const user = userEvent.setup();
    const ipc = vault(ITEMS, [githubView]).on("reveal_field", "s3cret!");
    renderVault();
    const detail = await openItem(user, "GitHub");
    const revealButton = await within(detail).findByRole("button", { name: "Reveal Password" });

    vi.useFakeTimers();
    fireEvent.click(revealButton);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ipc.callsTo("reveal_field")).toEqual([{ id: github.id, fieldId: 2 }]);
    expect(within(detail).getByText("s3cret!")).toBeInTheDocument();
    expect(within(detail).getByText("Hides in 10 s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(within(detail).getByText("s3cret!")).toBeInTheDocument();
    expect(within(detail).getByText("Hides in 1 s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(within(detail).queryByText("s3cret!")).not.toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Reveal Password" })).toBeInTheDocument();
  });

  it("hides a revealed value when efre loses focus", async () => {
    const user = userEvent.setup();
    vault(ITEMS, [githubView]).on("reveal_field", "s3cret!");
    renderVault();
    const detail = await openItem(user, "GitHub");
    await user.click(await within(detail).findByRole("button", { name: "Reveal Password" }));
    expect(await within(detail).findByText("s3cret!")).toBeInTheDocument();
    fireEvent.blur(window);
    expect(within(detail).queryByText("s3cret!")).not.toBeInTheDocument();
  });

  it("copies through Rust (copy_field), never through the JS clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(jsClipboard(), "writeText");
    const write = vi.spyOn(jsClipboard(), "write");
    const ipc = vault(ITEMS, [githubView]);
    renderVault();
    const detail = await openItem(user, "GitHub");

    await user.click(await within(detail).findByRole("button", { name: "Copy Username" }));
    await user.click(within(detail).getByRole("button", { name: "Copy Password" }));
    await waitFor(() => {
      expect(ipc.callsTo("copy_field")).toEqual([
        { id: github.id, fieldId: 1 },
        { id: github.id, fieldId: 2 },
      ]);
    });
    expect(await screen.findByText("Password copied — clears in 30 s")).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(ipc.callsTo("reveal_field")).toHaveLength(0);
  });

  it("renders a secure note as Markdown without raw HTML, images or links", async () => {
    const user = userEvent.setup();
    vault(ITEMS, [noteView]);
    renderVault();
    const detail = await openItem(user, "Emergency plan");
    const article = await within(detail).findByRole("article", { name: "Note" });
    expect(within(article).getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    // Raw HTML tags are dropped (their text stays), images and links aren't rendered.
    expect(article.querySelector("b, img, a, script")).toBeNull();
    expect(article).not.toHaveTextContent("<b>");
    expect(article).toHaveTextContent("raw docs (https://example.com)");
  });

  it("moves an item to the trash with Undo, which restores it", async () => {
    const user = userEvent.setup();
    const ipc = vault(ITEMS, [githubView]);
    renderVault();
    const detail = await openItem(user, "GitHub");
    await user.click(within(detail).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => {
      expect(ipc.callsTo("trash_item")).toEqual([{ id: github.id }]);
    });
    expect(screen.queryByRole("option", { name: /^GitHub,/ })).not.toBeInTheDocument();
    // The next item is selected instead.
    expect(option("Northwind Bank")).toHaveAttribute("aria-selected", "true");

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => {
      expect(ipc.callsTo("restore_item")).toEqual([{ id: github.id }]);
    });
    expect(await screen.findByRole("option", { name: /^GitHub,/ })).toHaveAttribute("aria-selected", "true");
  });

  it("restores and deletes permanently from the trash (after a confirmation)", async () => {
    const user = userEvent.setup();
    const ipc = vault(ITEMS);
    renderVault();
    await screen.findByRole("listbox", { name: "All items" });
    await user.click(screen.getByRole("button", { name: /^Trash/ }));
    const detail = await openItem(user, "Dropbox (old)");
    expect(within(detail).getByText("This item is in the trash")).toBeInTheDocument();

    await user.click(within(detail).getByRole("button", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete “Dropbox (old)” permanently?" });
    expect(ipc.callsTo("delete_item")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => {
      expect(ipc.callsTo("delete_item")).toEqual([{ id: dropbox.id }]);
    });
    expect(await screen.findByText("Trash is empty")).toBeInTheDocument();
  });
});

describe("item editor", () => {
  it("creates a login and sends the right ItemDraft (empty template fields dropped)", async () => {
    const user = userEvent.setup();
    const ipc = vault([github]).on("create_item", ({ draft }) =>
      makeItemMeta({ title: draft.title, kind: draft.kind, tags: draft.tags, username: "me@example.com" }),
    );
    renderVault();
    await screen.findByRole("listbox", { name: "All items" });

    await user.keyboard("{Control>}n{/Control}");
    await user.click(await screen.findByRole("menuitem", { name: /Login/ }));
    const form = await screen.findByRole("form", { name: "New login" });
    await waitFor(() => {
      expect(within(form).getByRole("textbox", { name: "Title" })).toHaveFocus();
    });

    await user.keyboard("Example");
    await user.type(within(form).getByRole("textbox", { name: "Username" }), "me@example.com");
    await user.click(within(form).getByRole("button", { name: "Generate" }));
    await user.click(await screen.findByRole("button", { name: "Use generated" }));
    expect(within(form).getByLabelText("Password")).toHaveValue("Gen3rated!");
    await user.type(within(form).getByRole("combobox", { name: "Tags" }), "work{Enter}");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(ipc.callsTo("create_item")).toHaveLength(1);
    });
    const expected: ItemDraft = {
      kind: "login",
      title: "Example",
      favorite: false,
      tags: ["work"],
      fields: [
        { id: null, label: "Username", kind: "text", role: "username", value: { set: "me@example.com" } },
        { id: null, label: "Password", kind: "hidden", role: "password", value: { set: "Gen3rated!" } },
      ],
    };
    expect(ipc.callsTo("create_item")[0]).toEqual({ draft: expected });
    expect(await screen.findByRole("region", { name: "Example" })).toBeInTheDocument();
  });

  it("requires a title, inline", async () => {
    const user = userEvent.setup();
    const ipc = vault([github]);
    renderVault();
    await screen.findByRole("listbox", { name: "All items" });
    await user.keyboard("{Control>}n{/Control}");
    await user.click(await screen.findByRole("menuitem", { name: /Card/ }));
    const form = await screen.findByRole("form", { name: "New card" });
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByText("Give this item a title.")).toBeInTheDocument();
    expect(within(form).getByRole("textbox", { name: "Title" })).toHaveAttribute("aria-invalid", "true");
    expect(ipc.callsTo("create_item")).toHaveLength(0);
  });

  it("edits without fetching secrets: hidden fields are sent as \"keep\"", async () => {
    const user = userEvent.setup();
    const ipc = vault(ITEMS, [githubView]).on("update_item", ({ id, draft }) => ({
      ...github,
      id,
      title: draft.title,
    }));
    renderVault();
    const detail = await openItem(user, "GitHub");
    await user.click(within(detail).getByRole("button", { name: "Edit" }));
    const form = await screen.findByRole("form", { name: "Edit login" });
    const title = within(form).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "GitHub (work)");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(ipc.callsTo("update_item")).toHaveLength(1);
    });
    const { id, draft } = ipc.callsTo("update_item")[0] ?? { id: "", draft: null };
    expect(id).toBe(github.id);
    expect(draft?.title).toBe("GitHub (work)");
    expect(draft?.fields.map((f) => [f.id, f.label, f.value])).toEqual([
      [1, "Username", "keep"],
      [2, "Password", "keep"],
      [3, "Website", "keep"],
    ]);
    expect(ipc.callsTo("reveal_field")).toHaveLength(0);
  });

  it("sends a new secret only after \"Change\"", async () => {
    const user = userEvent.setup();
    const ipc = vault(ITEMS, [githubView]).on("update_item", () => github);
    renderVault();
    const detail = await openItem(user, "GitHub");
    await user.click(within(detail).getByRole("button", { name: "Edit" }));
    const form = await screen.findByRole("form", { name: "Edit login" });
    expect(within(form).queryByLabelText("Password")).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Change Password" }));
    await user.type(within(form).getByLabelText("Password"), "n3w-secret");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(ipc.callsTo("update_item")).toHaveLength(1);
    });
    expect(ipc.callsTo("update_item")[0]?.draft.fields[1]).toEqual({
      id: 2,
      label: "Password",
      kind: "hidden",
      role: "password",
      value: { set: "n3w-secret" },
    });
  });

  it("Esc cancels; with unsaved changes it asks first", async () => {
    const user = userEvent.setup();
    vault([github]);
    renderVault();
    await screen.findByRole("listbox", { name: "All items" });

    await user.keyboard("{Control>}n{/Control}");
    await user.click(await screen.findByRole("menuitem", { name: /Identity/ }));
    await screen.findByRole("form", { name: "New identity" });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
    });

    await user.keyboard("{Control>}n{/Control}");
    await user.click(await screen.findByRole("menuitem", { name: /Identity/ }));
    await screen.findByRole("form", { name: "New identity" });
    await user.keyboard("Passport");
    await user.keyboard("{Escape}");
    const dialog = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Passport");
    await user.keyboard("{Escape}");
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
    });
  });
});

describe("shortcuts and commands", () => {
  it("Ctrl+F focuses the search field", async () => {
    const user = userEvent.setup();
    vault(ITEMS);
    renderVault();
    await screen.findByRole("listbox", { name: "All items" });
    await user.keyboard("{Control>}f{/Control}");
    expect(search()).toHaveFocus();
  });

  it("Ctrl+C copies the selected item's password and Ctrl+B its username, via copy_role", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(jsClipboard(), "writeText");
    const ipc = vault(ITEMS, [githubView]);
    renderVault();
    await openItem(user, "GitHub");

    await user.keyboard("{Control>}c{/Control}");
    await user.keyboard("{Control>}b{/Control}");
    await waitFor(() => {
      expect(ipc.callsTo("copy_role")).toEqual([
        { id: github.id, role: "password" },
        { id: github.id, role: "username" },
      ]);
    });
    expect(writeText).not.toHaveBeenCalled();

    // Selected text in the search field: Ctrl+C means "copy this text".
    await user.click(search());
    await user.keyboard("git");
    const input = search() as HTMLInputElement;
    input.setSelectionRange(0, 3);
    await user.keyboard("{Control>}c{/Control}");
    expect(ipc.callsTo("copy_role")).toHaveLength(2);
    // No selection in the search field: Ctrl+C copies the best match's password.
    input.setSelectionRange(3, 3);
    await user.keyboard("{Control>}c{/Control}");
    await waitFor(() => {
      expect(ipc.callsTo("copy_role")).toHaveLength(3);
    });
  });

  it("Ctrl+C says so when the item has no password, without calling Rust", async () => {
    const user = userEvent.setup();
    const ipc = vault(ITEMS, [noteView]);
    renderVault();
    await openItem(user, "Emergency plan");
    await user.keyboard("{Control>}c{/Control}");
    expect(await screen.findByText("No password to copy")).toBeInTheDocument();
    expect(ipc.callsTo("copy_role")).toHaveLength(0);
  });

  it("registers palette commands for new items, views, search and the selected item", async () => {
    const user = userEvent.setup();
    vault(ITEMS, [githubView]);
    renderVault();
    const commands = await screen.findByRole("list", { name: "Registered commands" });
    for (const title of ["New login", "New secure note", "New card", "New identity", "New custom item", "All items", "Favorites", "Logins", "Trash", "Tag: dev", "Search items", "Empty trash"]) {
      expect(within(commands).getByText(title)).toBeInTheDocument();
    }
    expect(within(commands).getByText("Copy password")).toHaveAttribute("data-enabled", "false");

    await openItem(user, "GitHub");
    for (const title of ["Copy password", "Copy username", "Edit item", "Add to favorites", "Move to trash"]) {
      expect(within(commands).getByText(title)).toHaveAttribute("data-enabled", "true");
    }
  });
});

describe("narrow window", () => {
  it("shows one pane at a time: the list, then the detail with Back; Esc goes back", async () => {
    setViewport(600);
    const user = userEvent.setup();
    vault(ITEMS, [githubView]);
    renderVault();
    await user.click(await screen.findByRole("option", { name: /^GitHub,/ }));
    expect(await screen.findByRole("region", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(await screen.findByRole("listbox", { name: "All items" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "GitHub" })).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("button", { name: "Back to list" }));
    expect(await screen.findByRole("listbox", { name: "All items" })).toHaveFocus();
  });
});
