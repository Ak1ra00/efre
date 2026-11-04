/**
 * The item editor's form model (pure): built from a kind's template or an opened item,
 * validated against Rust's limits (ITEM_LIMITS), and turned into an ItemDraft.
 *
 * Secrets never round-trip (ARCHITECTURE §8.3): an existing hidden field starts empty
 * and is sent as "keep" unless the user chooses "Change" and types a new value.
 */
import type { DraftValue, FieldDraft, FieldKind, FieldRole, ItemDraft, ItemKind, ItemView } from "@/lib/ipc-types";
import { ITEM_KINDS, ITEM_LIMITS } from "@/lib/items";

export interface FormField {
  /** Stable React key. */
  key: string;
  /** Existing field id, or null for a new one. */
  id: number | null;
  label: string;
  kind: FieldKind;
  role: FieldRole | null;
  /** What the user typed. Empty for an existing secret until they change it. */
  value: string;
  /** An existing non-secret field's stored value (to send "keep" when unchanged). */
  original: string | null;
  /** Existing secret only: the user chose "Change". */
  changing: boolean;
}

export interface FormState {
  kind: ItemKind;
  title: string;
  favorite: boolean;
  tags: string[];
  /** Text typed in the tag input but not yet added (added on save). */
  tagDraft: string;
  fields: FormField[];
}

export interface FormErrors {
  title?: string;
  tags?: string;
  form?: string;
  fields: Partial<Record<string, { label?: string; value?: string }>>;
}

// Rust rejects control characters (`char::is_control`) in titles, labels and tags.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const encoder = new TextEncoder();
const chars = (s: string) => Array.from(s).length;

function templateFields(kind: ItemKind): FormField[] {
  return ITEM_KINDS[kind].template.map((t, i) => ({
    key: `t${String(i)}`,
    id: null,
    label: t.label,
    kind: t.kind,
    role: t.role,
    value: "",
    original: null,
    changing: false,
  }));
}

export function createForm(kind: ItemKind): FormState {
  return { kind, title: "", favorite: false, tags: [], tagDraft: "", fields: templateFields(kind) };
}

/**
 * The form for an existing item. Template fields the item lacks (say, a login saved
 * without a password) are offered again, empty; they are only saved if filled in.
 */
export function editForm(view: ItemView): FormState {
  const fields: FormField[] = view.fields.map((f) => ({
    key: `f${String(f.id)}`,
    id: f.id,
    label: f.label,
    kind: f.kind,
    role: f.role,
    value: f.kind === "hidden" ? "" : (f.value ?? ""),
    original: f.kind === "hidden" ? null : (f.value ?? ""),
    changing: false,
  }));
  templateFields(view.meta.kind).forEach((t, index) => {
    const present =
      t.role === null
        ? fields.some((f) => f.kind === t.kind && f.label.trim().toLowerCase() === t.label.toLowerCase())
        : fields.some((f) => f.role === t.role);
    if (!present) fields.splice(Math.min(index, fields.length), 0, t);
  });
  return {
    kind: view.meta.kind,
    title: view.meta.title,
    favorite: view.meta.favorite,
    tags: [...view.meta.tags],
    tagDraft: "",
    fields,
  };
}

/** Problems with a tag the user wants to add (null when it can be added). */
export function tagProblem(tag: string, tags: readonly string[]): string | null {
  if (CONTROL.test(tag)) return "Tags must be on one line.";
  if (chars(tag) > ITEM_LIMITS.tagChars) return `Tags can be at most ${String(ITEM_LIMITS.tagChars)} characters.`;
  if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return `“${tag}” is already a tag of this item.`;
  if (tags.length >= ITEM_LIMITS.tags) return `An item can have at most ${String(ITEM_LIMITS.tags)} tags.`;
  return null;
}

/** Fields that will be saved (new fields left empty are dropped). */
function savedFields(form: FormState): FormField[] {
  return form.fields.filter((f) => f.id !== null || f.value !== "");
}

export function validate(form: FormState): FormErrors {
  const errors: FormErrors = { fields: {} };
  const title = form.title.trim();
  if (title === "") errors.title = "Give this item a title.";
  else if (chars(title) > ITEM_LIMITS.titleChars) {
    errors.title = `Titles can be at most ${String(ITEM_LIMITS.titleChars)} characters.`;
  } else if (CONTROL.test(title)) errors.title = "Titles must be on one line, without tabs.";

  for (const field of form.fields) {
    const problems: { label?: string; value?: string } = {};
    const label = field.label.trim();
    if (chars(label) > ITEM_LIMITS.labelChars) {
      problems.label = `Labels can be at most ${String(ITEM_LIMITS.labelChars)} characters.`;
    } else if (CONTROL.test(label)) problems.label = "Labels must be on one line, without tabs.";
    if (encoder.encode(field.value).length > ITEM_LIMITS.valueBytes) {
      problems.value = `This is too long: a field holds at most ${String(ITEM_LIMITS.valueBytes / 1024)} KB.`;
    }
    if (problems.label !== undefined || problems.value !== undefined) errors.fields[field.key] = problems;
  }

  if (savedFields(form).length > ITEM_LIMITS.fields) {
    errors.form = `An item can have at most ${String(ITEM_LIMITS.fields)} fields.`;
  }
  const pending = form.tagDraft.trim();
  if (pending !== "") {
    const problem = tagProblem(pending, form.tags);
    if (problem !== null) errors.tags = problem;
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return (
    errors.title !== undefined ||
    errors.tags !== undefined ||
    errors.form !== undefined ||
    Object.keys(errors.fields).length > 0
  );
}

/** The tags to save: the chips plus whatever is still typed in the tag input. */
export function finalTags(form: FormState): string[] {
  const pending = form.tagDraft.trim();
  return pending === "" || tagProblem(pending, form.tags) !== null ? form.tags : [...form.tags, pending];
}

export function buildDraft(form: FormState): ItemDraft {
  const fields = savedFields(form).map((f): FieldDraft => {
    let value: DraftValue;
    if (f.id === null) value = { set: f.value };
    else if (f.kind === "hidden") value = f.changing && f.value !== "" ? { set: f.value } : "keep";
    else value = f.value === f.original ? "keep" : { set: f.value };
    return { id: f.id, label: f.label.trim(), kind: f.kind, role: f.role, value };
  });
  return { kind: form.kind, title: form.title.trim(), favorite: form.favorite, tags: finalTags(form), fields };
}

/** Compares two forms for "unsaved changes". */
export function fingerprint(form: FormState): string {
  return JSON.stringify([
    form.title,
    form.tags,
    form.tagDraft.trim(),
    form.fields.map((f) => [f.key, f.label, f.value, f.changing]),
  ]);
}
