/** Key nicknames: shown in the key list and in "Use “Backup”" prompts. Rust validates them too. */
import { ITEM_LIMITS } from "@/lib/items";

// Mirrors Rust's `char::is_control`.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Inline validation message, or null when `raw` (trimmed) is a good nickname. */
export function nicknameError(raw: string, taken: readonly string[] = []): string | null {
  const name = raw.trim();
  if (name === "") return "Give this key a name.";
  if (Array.from(name).length > ITEM_LIMITS.nicknameChars) {
    return `Use at most ${String(ITEM_LIMITS.nicknameChars)} characters.`;
  }
  if (CONTROL.test(name)) return "Use letters, numbers, spaces and punctuation only.";
  const lower = name.toLocaleLowerCase();
  if (taken.some((other) => other.trim().toLocaleLowerCase() === lower)) {
    return `Another key is already called “${name}”. Pick a different name.`;
  }
  return null;
}

/** `base`, or `base 2`, `base 3`… if that name is taken. */
export function uniqueNickname(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${String(n)}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
}
