import { describe, expect, it } from "vitest";

import { makeItemMeta } from "@/test/fixtures";

import {
  highlightRuns,
  inView,
  matchText,
  prepareItems,
  prepareText,
  queryTerms,
  viewCounts,
  visibleItems,
} from "./search";

const DAY = 86_400;

const items = [
  makeItemMeta({ title: "GitHub", username: "octocat", tags: ["dev", "work"], favorite: true, updatedAt: 10 * DAY, createdAt: 1 * DAY }),
  makeItemMeta({ title: "GitHub recovery codes", kind: "secureNote", username: null, tags: ["dev"], updatedAt: 3 * DAY, createdAt: 2 * DAY }),
  makeItemMeta({ title: "Proton Mail", username: "amastan@proton.me", tags: ["email"], updatedAt: 5 * DAY, createdAt: 3 * DAY }),
  makeItemMeta({ title: "Northwind Bank", username: "40812233", tags: ["finance"], updatedAt: 1 * DAY, createdAt: 4 * DAY }),
  makeItemMeta({ title: "Visa · Everyday", kind: "card", username: null, tags: ["finance"], updatedAt: 7 * DAY, createdAt: 5 * DAY }),
  makeItemMeta({ title: "Café Crème", kind: "custom", username: null, updatedAt: 2 * DAY, createdAt: 6 * DAY }),
  makeItemMeta({ title: "Dropbox (old)", trashedAt: 9 * DAY, updatedAt: 9 * DAY, createdAt: 7 * DAY }),
];
const prepared = prepareItems(items);
const titles = (query: string, sort: "title" | "updated" | "created" = "title", view = { type: "all" } as const) =>
  visibleItems(prepared, view, query, sort).map((hit) => hit.item.title);

describe("fuzzy matching", () => {
  it("matches subsequences, ignoring case and accents", () => {
    expect(matchText(queryTerms("gh")[0] ?? [], prepareText("GitHub"))).not.toBeNull();
    expect(matchText(queryTerms("CAFE")[0] ?? [], prepareText("Café Crème"))).not.toBeNull();
    expect(matchText(queryTerms("creme")[0] ?? [], prepareText("Café Crème"))).not.toBeNull();
    expect(matchText(queryTerms("xyz")[0] ?? [], prepareText("GitHub"))).toBeNull();
  });

  it("prefers word starts and consecutive letters, and drops scattered noise", () => {
    const score = (q: string, text: string) => matchText(queryTerms(q)[0] ?? [], prepareText(text))?.score ?? null;
    const prefix = score("git", "GitHub") ?? 0;
    const inner = score("git", "Legit tools") ?? 0;
    expect(prefix).toBeGreaterThan(inner);
    // Initials of words: "grc" → GitHub Recovery Codes.
    expect(score("grc", "GitHub recovery codes")).not.toBeNull();
    // Two letters scattered inside words are noise.
    expect(score("ae", "Example site")).toBeNull();
  });

  it("reports matched positions in the original text (for highlighting)", () => {
    const match = matchText(queryTerms("hub")[0] ?? [], prepareText("GitHub"));
    expect(match?.positions).toEqual([3, 4, 5]);
    expect(highlightRuns("GitHub", match?.positions ?? [])).toEqual([
      { text: "Git", match: false },
      { text: "Hub", match: true },
    ]);
  });
});

describe("visible items", () => {
  it("filters by view and leaves trashed items to the Trash", () => {
    expect(titles("")).not.toContain("Dropbox (old)");
    expect(titles("", "title", { type: "trash" } as never)).toEqual(["Dropbox (old)"]);
    expect(visibleItems(prepared, { type: "favorites" }, "", "title").map((h) => h.item.title)).toEqual(["GitHub"]);
    expect(visibleItems(prepared, { type: "kind", kind: "card" }, "", "title").map((h) => h.item.title)).toEqual([
      "Visa · Everyday",
    ]);
    expect(visibleItems(prepared, { type: "tag", tag: "finance" }, "", "title").map((h) => h.item.title)).toEqual([
      "Northwind Bank",
      "Visa · Everyday",
    ]);
    expect(inView(items[6] ?? makeItemMeta(), { type: "all" })).toBe(false);
  });

  it("sorts by title, recently updated or recently created", () => {
    expect(titles("")).toEqual([
      "Café Crème",
      "GitHub",
      "GitHub recovery codes",
      "Northwind Bank",
      "Proton Mail",
      "Visa · Everyday",
    ]);
    expect(titles("", "updated")[0]).toBe("GitHub");
    expect(titles("", "updated").at(-1)).toBe("Northwind Bank");
    expect(titles("", "created")[0]).toBe("Café Crème");
  });

  it("searches title, username, tags and kind, best match first", () => {
    expect(titles("github")).toEqual(["GitHub", "GitHub recovery codes"]);
    // Username.
    expect(titles("octo")).toEqual(["GitHub"]);
    // Tag.
    expect(titles("finance")).toEqual(["Northwind Bank", "Visa · Everyday"]);
    // Kind ("Card"), and fuzzy ("nwb" → Northwind Bank).
    expect(titles("card")).toEqual(["Visa · Everyday"]);
    expect(titles("nwb")).toEqual(["Northwind Bank"]);
    // Every term must match something.
    expect(titles("github work")).toEqual(["GitHub"]);
    expect(titles("github nothing")).toEqual([]);
  });

  it("counts views for the sidebar", () => {
    const counts = viewCounts(items);
    expect(counts.all).toBe(6);
    expect(counts.trash).toBe(1);
    expect(counts.favorites).toBe(1);
    expect(counts.kinds).toEqual({ login: 3, secureNote: 1, card: 1, identity: 0, custom: 1 });
    expect(counts.tags).toEqual([
      { tag: "dev", count: 2 },
      { tag: "email", count: 1 },
      { tag: "finance", count: 2 },
      { tag: "work", count: 1 },
    ]);
  });
});
