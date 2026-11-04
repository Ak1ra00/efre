/**
 * Views, sorting and the instant fuzzy search over list metadata (title, username, tags,
 * kind). Pure functions: the vault screen prepares the index once per list change and
 * scores it on every keystroke.
 *
 * The scorer is fzy's algorithm (https://github.com/jhawthorn/fzy, MIT): the best
 * alignment of the query as a subsequence, rewarding consecutive letters and word
 * starts and lightly penalising gaps. Case and accents are ignored.
 */
import type { ItemKind, ItemMeta } from "@/lib/ipc-types";
import { ITEM_KIND_ORDER, ITEM_KINDS } from "@/lib/items";

export type VaultView =
  | { type: "all" }
  | { type: "favorites" }
  | { type: "kind"; kind: ItemKind }
  | { type: "tag"; tag: string }
  | { type: "trash" };

export type SortKey = "title" | "updated" | "created";

export const SORT_OPTIONS: readonly { key: SortKey; label: string }[] = [
  { key: "title", label: "Title A–Z" },
  { key: "updated", label: "Recently updated" },
  { key: "created", label: "Recently created" },
];

/** Plural labels for the sidebar ("Logins"). */
export const KIND_PLURALS: Readonly<Record<ItemKind, string>> = {
  login: "Logins",
  secureNote: "Secure notes",
  card: "Cards",
  identity: "Identities",
  custom: "Custom",
};

/** Plural nouns for sentences ("No cards yet"). */
export const KIND_NOUN_PLURALS: Readonly<Record<ItemKind, string>> = {
  login: "logins",
  secureNote: "secure notes",
  card: "cards",
  identity: "identities",
  custom: "custom items",
};

export function viewLabel(view: VaultView): string {
  switch (view.type) {
    case "all":
      return "All items";
    case "favorites":
      return "Favorites";
    case "kind":
      return KIND_PLURALS[view.kind];
    case "tag":
      return view.tag;
    case "trash":
      return "Trash";
  }
}

export function sameView(a: VaultView, b: VaultView): boolean {
  if (a.type === "kind" && b.type === "kind") return a.kind === b.kind;
  if (a.type === "tag" && b.type === "tag") return a.tag === b.tag;
  return a.type === b.type;
}

export function inView(item: ItemMeta, view: VaultView): boolean {
  if (view.type === "trash") return item.trashedAt !== null;
  if (item.trashedAt !== null) return false;
  switch (view.type) {
    case "all":
      return true;
    case "favorites":
      return item.favorite;
    case "kind":
      return item.kind === view.kind;
    case "tag":
      return item.tags.includes(view.tag);
  }
}

export interface ViewCounts {
  all: number;
  favorites: number;
  trash: number;
  kinds: Record<ItemKind, number>;
  /** Tags of items outside the trash, A–Z. */
  tags: readonly { tag: string; count: number }[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function viewCounts(items: readonly ItemMeta[]): ViewCounts {
  const kinds = Object.fromEntries(ITEM_KIND_ORDER.map((kind) => [kind, 0])) as Record<ItemKind, number>;
  const tags = new Map<string, number>();
  let all = 0;
  let favorites = 0;
  let trash = 0;
  for (const item of items) {
    if (item.trashedAt !== null) {
      trash += 1;
      continue;
    }
    all += 1;
    if (item.favorite) favorites += 1;
    kinds[item.kind] += 1;
    for (const tag of item.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return {
    all,
    favorites,
    trash,
    kinds,
    tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => collator.compare(a.tag, b.tag)),
  };
}

/* ------------------------------------------------------------------------------------ */
/* Fuzzy matching                                                                        */
/* ------------------------------------------------------------------------------------ */

const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const MATCH_CONSECUTIVE = 1.0;
const BONUS_START = 0.9;
const BONUS_WORD = 0.8;
const BONUS_CAPITAL = 0.7;
const BONUS_DOT = 0.6;
const BONUS_DIGIT = 0.5;
/** Long values (a pasted username) are only searched at their start. */
const MAX_SEARCH_CHARS = 256;
/** Below this score per query character a scattered match is noise ("ae" in "Example"). */
const MIN_SCORE_PER_CHAR = 0.2;

/** A string folded for matching: one entry per folded character, mapped to the original. */
export interface PreparedText {
  text: string;
  chars: readonly string[];
  /** UTF-16 index in `text` of each folded character. */
  map: readonly number[];
  /** Word-start bonus of each folded character. */
  bonus: Float64Array;
}

const MARKS = /\p{M}+/gu;

function foldChar(ch: string): string {
  return ch.normalize("NFD").replace(MARKS, "").toLowerCase().replace(MARKS, "");
}

type CharClass = "upper" | "lower" | "digit" | "dot" | "other";

function classify(ch: string): CharClass {
  if (/\p{Lu}/u.test(ch)) return "upper";
  if (/\p{L}/u.test(ch)) return "lower";
  if (/\p{N}/u.test(ch)) return "digit";
  return ch === "." ? "dot" : "other";
}

function bonusFor(previous: CharClass | null, current: CharClass): number {
  if (current === "other" || current === "dot") return 0;
  if (previous === null) return BONUS_START;
  if (previous === "other") return BONUS_WORD;
  if (previous === "dot") return BONUS_DOT;
  if (current === "upper" && previous === "lower") return BONUS_CAPITAL;
  if (current === "digit" && previous !== "digit") return BONUS_DIGIT;
  if (current !== "digit" && previous === "digit") return BONUS_DIGIT;
  return 0;
}

export function prepareText(text: string): PreparedText {
  const chars: string[] = [];
  const map: number[] = [];
  const bonuses: number[] = [];
  let index = 0;
  let previous: CharClass | null = null;
  for (const ch of text) {
    if (chars.length >= MAX_SEARCH_CHARS) break;
    const current = classify(ch);
    const bonus = bonusFor(previous, current);
    let first = true;
    for (const folded of foldChar(ch)) {
      chars.push(folded);
      map.push(index);
      bonuses.push(first ? bonus : 0);
      first = false;
    }
    previous = current;
    index += ch.length;
  }
  return { text, chars, map, bonus: Float64Array.from(bonuses) };
}

/** Splits a query into folded terms (whitespace separates terms). */
export function queryTerms(query: string): string[][] {
  return query
    .split(/\s+/u)
    .filter((term) => term !== "")
    .map((term) => Array.from(term).flatMap((ch) => Array.from(foldChar(ch))));
}

export interface TextMatch {
  score: number;
  /** UTF-16 indexes in the original text of the matched characters. */
  positions: readonly number[];
}

/** Scores `needle` (folded characters) against `hay`, or null when it doesn't match. */
export function matchText(needle: readonly string[], hay: PreparedText): TextMatch | null {
  const n = needle.length;
  const m = hay.chars.length;
  if (n === 0) return { score: 0, positions: [] };
  if (n > m) return null;

  // Quick reject: the query must be a subsequence.
  let k = 0;
  for (let j = 0; j < m && k < n; j++) if (hay.chars[j] === needle[k]) k += 1;
  if (k < n) return null;

  const toOriginal = (positions: number[]) => [...new Set(positions.map((p) => hay.map[p] ?? 0))];

  if (n === m) {
    // Equal after folding: the best possible match.
    return { score: n + 1, positions: toOriginal(Array.from({ length: n }, (_, i) => i)) };
  }

  const D = new Float64Array(n * m);
  const M = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    let previous = Number.NEGATIVE_INFINITY;
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;
    for (let j = 0; j < m; j++) {
      const cell = i * m + j;
      if (needle[i] === hay.chars[j]) {
        let score = Number.NEGATIVE_INFINITY;
        if (i === 0) {
          score = j * GAP_LEADING + (hay.bonus[j] ?? 0);
        } else if (j > 0) {
          const before = (i - 1) * m + j - 1;
          score = Math.max((M[before] ?? 0) + (hay.bonus[j] ?? 0), (D[before] ?? 0) + MATCH_CONSECUTIVE);
        }
        D[cell] = score;
        previous = Math.max(score, previous + gap);
        M[cell] = previous;
      } else {
        D[cell] = Number.NEGATIVE_INFINITY;
        previous += gap;
        M[cell] = previous;
      }
    }
  }

  // Trace back the alignment that produced the best score.
  const positions = new Array<number>(n).fill(0);
  let matchRequired = false;
  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const cell = i * m + j;
      const d = D[cell] ?? Number.NEGATIVE_INFINITY;
      if (d !== Number.NEGATIVE_INFINITY && (matchRequired || d === M[cell])) {
        matchRequired = i > 0 && j > 0 && M[cell] === (D[(i - 1) * m + j - 1] ?? 0) + MATCH_CONSECUTIVE;
        positions[i] = j;
        j -= 1;
        break;
      }
    }
  }

  const score = M[n * m - 1] ?? Number.NEGATIVE_INFINITY;
  if (n > 1 && score < n * MIN_SCORE_PER_CHAR) return null;
  return { score, positions: toOriginal(positions) };
}

/* ------------------------------------------------------------------------------------ */
/* Items                                                                                 */
/* ------------------------------------------------------------------------------------ */

export interface PreparedItem {
  item: ItemMeta;
  title: PreparedText;
  username: PreparedText | null;
  tags: readonly PreparedText[];
  kind: PreparedText;
}

export function prepareItems(items: readonly ItemMeta[]): PreparedItem[] {
  const kinds = new Map(ITEM_KIND_ORDER.map((kind) => [kind, prepareText(ITEM_KINDS[kind].label)]));
  return items.map((item) => ({
    item,
    title: prepareText(item.title),
    username: item.username === null ? null : prepareText(item.username),
    tags: item.tags.map(prepareText),
    kind: kinds.get(item.kind) ?? prepareText(ITEM_KINDS[item.kind].label),
  }));
}

export interface SearchHit {
  item: ItemMeta;
  /** 0 without a query. */
  score: number;
  titlePositions: readonly number[];
  usernamePositions: readonly number[];
}

/** A slight preference for title matches, then username and tags, over the kind name. */
const FIELD_BIAS = { title: 0.5, username: 0.25, tag: 0.2, kind: 0 } as const;

interface Candidate {
  field: "title" | "username" | "other";
  score: number;
  positions: readonly number[];
}

function bestCandidate(entry: PreparedItem, term: readonly string[]): Candidate | null {
  const candidates: Candidate[] = [];
  const add = (field: Candidate["field"], text: PreparedText, bias: number) => {
    const match = matchText(term, text);
    if (match !== null) candidates.push({ field, score: match.score + bias, positions: match.positions });
  };
  add("title", entry.title, FIELD_BIAS.title);
  if (entry.username !== null) add("username", entry.username, FIELD_BIAS.username);
  for (const tag of entry.tags) add("other", tag, FIELD_BIAS.tag);
  add("other", entry.kind, FIELD_BIAS.kind);
  let best: Candidate | null = null;
  for (const candidate of candidates) if (best === null || candidate.score > best.score) best = candidate;
  return best;
}

function searchItem(entry: PreparedItem, terms: readonly (readonly string[])[]): SearchHit | null {
  let total = 0;
  const titlePositions = new Set<number>();
  const usernamePositions = new Set<number>();
  for (const term of terms) {
    const best = bestCandidate(entry, term);
    if (best === null) return null;
    total += best.score;
    const target = best.field === "title" ? titlePositions : best.field === "username" ? usernamePositions : null;
    for (const p of best.positions) target?.add(p);
  }
  return {
    item: entry.item,
    score: total,
    titlePositions: [...titlePositions].sort((a, b) => a - b),
    usernamePositions: [...usernamePositions].sort((a, b) => a - b),
  };
}

export function compareItems(a: ItemMeta, b: ItemMeta, sort: SortKey): number {
  const byTitle = collator.compare(a.title, b.title) || a.id.localeCompare(b.id);
  switch (sort) {
    case "title":
      return byTitle;
    case "updated":
      return b.updatedAt - a.updatedAt || byTitle;
    case "created":
      return b.createdAt - a.createdAt || byTitle;
  }
}

/**
 * The list for a view: items in the view that match every query term, best match
 * first (ties keep the chosen sort), or simply sorted without a query.
 */
export function visibleItems(
  prepared: readonly PreparedItem[],
  view: VaultView,
  query: string,
  sort: SortKey,
): SearchHit[] {
  const terms = queryTerms(query);
  const hits: SearchHit[] = [];
  for (const entry of prepared) {
    if (!inView(entry.item, view)) continue;
    if (terms.length === 0) {
      hits.push({ item: entry.item, score: 0, titlePositions: [], usernamePositions: [] });
      continue;
    }
    const hit = searchItem(entry, terms);
    if (hit !== null) hits.push(hit);
  }
  return hits.sort((a, b) => b.score - a.score || compareItems(a.item, b.item, sort));
}

/** Splits `text` into runs, marking the characters at `positions` (for highlighting). */
export function highlightRuns(text: string, positions: readonly number[]): { text: string; match: boolean }[] {
  if (positions.length === 0) return [{ text, match: false }];
  const marked = new Set(positions);
  const runs: { text: string; match: boolean }[] = [];
  let index = 0;
  for (const ch of text) {
    const match = marked.has(index);
    const last = runs.at(-1);
    if (last?.match === match) last.text += ch;
    else runs.push({ text: ch, match });
    index += ch.length;
  }
  return runs;
}
