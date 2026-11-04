import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  AtSign,
  Calendar,
  Eye,
  EyeOff,
  Link,
  type LucideIcon,
  Phone,
  Plus,
  RotateCw,
  Text,
  TextCursorInput,
  Undo2,
  WandSparkles,
  X,
} from "lucide-react";
import { type SubmitEvent, useEffect, useId, useRef, useState } from "react";

import { useUIState } from "@/app/ui-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tip } from "@/components/ui/tooltip";
import { friendlyError, ipc } from "@/lib/ipc";
import type { FieldKind, ItemMeta } from "@/lib/ipc-types";
import { FIELD_KIND_ORDER, FIELD_KINDS, ITEM_KINDS, ITEM_LIMITS } from "@/lib/items";
import { cn } from "@/lib/utils";

import { buildDraft, createForm, editForm, fingerprint, type FormField, type FormState, hasErrors, validate } from "./draft";
import { fieldLabel } from "./FieldRow";
import { useItemView } from "./ItemDetail";
import { KindIcon } from "./KindIcon";
import { TagInput } from "./TagInput";
import { useVault } from "./vault-context";
import type { EditorTarget } from "./vault-reducer";

const KIND_ICONS: Readonly<Record<FieldKind, LucideIcon>> = {
  text: Text,
  hidden: TextCursorInput,
  url: Link,
  email: AtSign,
  phone: Phone,
  date: Calendar,
  multiline: Text,
};

const PLACEHOLDERS: Partial<Record<FieldKind, string>> = {
  url: "https://",
  email: "name@example.com",
  phone: "+1 555 0100",
  date: "YYYY-MM-DD",
};

const INPUT_MODES: Partial<Record<FieldKind, "url" | "email" | "tel">> = { url: "url", email: "email", phone: "tel" };

/** Create or edit an item, in the detail pane. */
export function ItemEditor({ target }: { target: EditorTarget }) {
  if (target.mode === "create") return <EditorForm initial={createForm(target.kind)} itemId={null} />;
  return <EditLoader key={target.id} id={target.id} />;
}

function EditLoader({ id }: { id: string }) {
  const { actions, setDetailElement } = useVault();
  const [attempt, setAttempt] = useState(0);
  const loaded = useItemView(id, attempt, () => {
    void actions.reload();
  });
  if (loaded.status === "ready") return <EditorForm initial={editForm(loaded.view)} itemId={id} />;
  return (
    <section ref={setDetailElement} tabIndex={-1} aria-label="Edit item" className="flex h-full flex-col outline-none">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <Skeleton className="h-4 w-32" />
        <Button variant="ghost" size="sm" className="ml-auto" onClick={actions.cancelEditor}>
          Cancel
        </Button>
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
        {loaded.status === "error" ? (
          <Alert
            variant="danger"
            role="alert"
            title="Couldn't open this item for editing"
            action={
              <Button
                size="sm"
                onClick={() => {
                  setAttempt((n) => n + 1);
                }}
              >
                <RotateCw aria-hidden="true" />
                Try again
              </Button>
            }
          >
            {friendlyError(loaded.error).description}
          </Alert>
        ) : (
          <div aria-busy="true" className="flex animate-fade-in flex-col gap-4 [animation-delay:150ms]">
            <span className="sr-only">Loading</span>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
      </div>
    </section>
  );
}

function EditorForm({ initial, itemId }: { initial: FormState; itemId: string | null }) {
  const { state, layout, counts, actions, setDetailElement } = useVault();
  const ui = useUIState();
  const [form, setForm] = useState(initial);
  const [initialPrint] = useState(() => fingerprint(initial));
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tagProblemText, setTagProblem] = useState<string | null>(null);
  const [revealedInputs, setRevealedInputs] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const nextKey = useRef(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const headingId = useId();
  const fieldsHeadingId = useId();

  const creating = itemId === null;
  const kind = ITEM_KINDS[form.kind];
  const errors = validate(form);
  const dirty = fingerprint(form) !== initialPrint;
  const existing: ItemMeta | null = itemId === null ? null : (state.items?.find((i) => i.id === itemId) ?? null);

  useEffect(() => {
    actions.setEditorDirty(dirty);
  }, [actions, dirty]);
  useEffect(
    () => () => {
      actions.setEditorDirty(false);
    },
    [actions],
  );
  // Focus moves on the next task: the menu that opened the editor (or added the field)
  // must close first, or its focus trap would pull focus straight back.
  useEffect(() => {
    const timer = setTimeout(() => {
      titleRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (focusKey === null) return;
    const timer = setTimeout(() => {
      formRef.current?.querySelector<HTMLElement>(`[data-field-key="${focusKey}"] [data-autofocus]`)?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [focusKey]);

  const update = (key: string, patch: Partial<FormField>) => {
    setForm((f) => ({ ...f, fields: f.fields.map((field) => (field.key === key ? { ...field, ...patch } : field)) }));
  };
  const remove = (key: string) => {
    setForm((f) => ({ ...f, fields: f.fields.filter((field) => field.key !== key) }));
  };
  const moveField = (key: string, delta: -1 | 1) => {
    setForm((f) => {
      const index = f.fields.findIndex((field) => field.key === key);
      const to = index + delta;
      if (index === -1 || to < 0 || to >= f.fields.length) return f;
      const fields = [...f.fields];
      const [moved] = fields.splice(index, 1);
      if (moved !== undefined) fields.splice(to, 0, moved);
      return { ...f, fields };
    });
  };
  const addField = (fieldKind: FieldKind) => {
    nextKey.current += 1;
    const key = `n${String(nextKey.current)}`;
    setForm((f) => ({
      ...f,
      fields: [
        ...f.fields,
        { key, id: null, label: "", kind: fieldKind, role: null, value: "", original: null, changing: false },
      ],
    }));
    setFocusKey(key);
  };
  const toggleRevealed = (key: string) => {
    setRevealedInputs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const generateInto = (key: string) => {
    ui.requestGenerator((value) => {
      update(key, { value, changing: true });
    });
  };

  const onSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    if (hasErrors(errors)) {
      // Focus the first control with a problem.
      requestAnimationFrame(() => {
        formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      });
      return;
    }
    const draft = { ...buildDraft(form), favorite: existing?.favorite ?? form.favorite };
    setSaving(true);
    try {
      const meta = itemId === null ? await ipc.createItem(draft) : await ipc.updateItem(itemId, draft);
      actions.editorSaved(meta);
    } catch (err: unknown) {
      setSaving(false);
      actions.report(err, "Couldn't save the item");
    }
  };

  const show = (message: string | undefined) => (submitted ? message : undefined);
  const titleError = submitted ? errors.title : form.title.length > ITEM_LIMITS.titleChars ? errors.title : undefined;

  return (
    <form
      ref={(element) => {
        formRef.current = element;
        setDetailElement(element);
      }}
      tabIndex={-1}
      noValidate
      aria-labelledby={headingId}
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        {layout === "narrow" ? (
          <Tip label="Cancel" shortcut="Esc">
            <Button variant="ghost" size="icon" aria-label="Cancel editing" onClick={actions.cancelEditor}>
              <ArrowLeft aria-hidden="true" />
            </Button>
          </Tip>
        ) : null}
        <h2 id={headingId} className="min-w-0 truncate pl-1 text-sm font-semibold">
          {creating ? `New ${kind.noun}` : `Edit ${kind.noun}`}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={actions.cancelEditor} aria-keyshortcuts="Escape">
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" loading={saving}>
            Save
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
          {submitted && hasErrors(errors) ? (
            <Alert variant="danger" role="alert" title="Some fields need attention">
              {errors.form ?? "Fix the highlighted fields, then save again."}
            </Alert>
          ) : null}

          <div className="flex items-start gap-4">
            <KindIcon kind={form.kind} size="lg" className="mt-6" />
            <Field label="Title" error={titleError} className="min-w-0 flex-1">
              {(p) => (
                <Input
                  {...p}
                  ref={titleRef}
                  value={form.title}
                  required
                  placeholder={`Name this ${kind.noun}`}
                  onChange={(event) => {
                    const title = event.target.value;
                    setForm((f) => ({ ...f, title }));
                  }}
                  className="h-10 text-base font-medium"
                />
              )}
            </Field>
          </div>

          <section aria-labelledby={fieldsHeadingId} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 id={fieldsHeadingId} className="text-[13px] font-medium text-fg-muted">
                Fields
              </h3>
              <AddFieldMenu disabled={form.fields.length >= ITEM_LIMITS.fields} onAdd={addField} />
            </div>
            {form.fields.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-fg-subtle">
                No fields. Add one with “Add field”.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-highlight">
                {form.fields.map((field, index) => (
                  <FieldEditor
                    key={field.key}
                    field={field}
                    index={index}
                    count={form.fields.length}
                    secureNoteBody={form.kind === "secureNote" && field.role === "notes"}
                    revealed={revealedInputs.has(field.key)}
                    errors={errors.fields[field.key]}
                    onChange={(patch) => {
                      update(field.key, patch);
                    }}
                    onRemove={() => {
                      remove(field.key);
                    }}
                    onMove={(delta) => {
                      moveField(field.key, delta);
                    }}
                    onToggleRevealed={() => {
                      toggleRevealed(field.key);
                    }}
                    onGenerate={
                      field.role === "password"
                        ? () => {
                            generateInto(field.key);
                          }
                        : null
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <Field
            label="Tags"
            hint="Press Enter or type a comma to add a tag."
            error={tagProblemText ?? show(errors.tags)}
          >
            {(p) => (
              <TagInput
                {...p}
                tags={form.tags}
                draft={form.tagDraft}
                suggestions={counts.tags.map((t) => t.tag)}
                onTagsChange={(tags) => {
                  setForm((f) => ({ ...f, tags }));
                }}
                onDraftChange={(tagDraft) => {
                  setForm((f) => ({ ...f, tagDraft }));
                }}
                onProblem={setTagProblem}
              />
            )}
          </Field>
        </div>
      </div>
    </form>
  );
}

function AddFieldMenu({ disabled, onAdd }: { disabled: boolean; onAdd: (kind: FieldKind) => void }) {
  const added = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled}>
          <Plus aria-hidden="true" />
          Add field
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          // Focus goes to the new field's label instead.
          if (added.current) event.preventDefault();
          added.current = false;
        }}
      >
        <DropdownMenuLabel>Field type</DropdownMenuLabel>
        {FIELD_KIND_ORDER.map((fieldKind) => {
          const Icon = KIND_ICONS[fieldKind];
          return (
            <DropdownMenuItem
              key={fieldKind}
              onSelect={() => {
                added.current = true;
                onAdd(fieldKind);
              }}
            >
              <Icon aria-hidden="true" />
              {FIELD_KINDS[fieldKind].label}
              {fieldKind === "hidden" ? <span className="ml-auto text-xs text-fg-subtle">secret</span> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface FieldEditorProps {
  field: FormField;
  index: number;
  count: number;
  secureNoteBody: boolean;
  revealed: boolean;
  errors: { label?: string; value?: string } | undefined;
  onChange: (patch: Partial<FormField>) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  onToggleRevealed: () => void;
  onGenerate: (() => void) | null;
}

function FieldEditor({
  field,
  index,
  count,
  secureNoteBody,
  revealed,
  errors,
  onChange,
  onRemove,
  onMove,
  onToggleRevealed,
  onGenerate,
}: FieldEditorProps) {
  const id = useId();
  const name = fieldLabel(field);
  const labelError = errors?.label;
  const valueError = errors?.value;
  const changeButton = useRef<HTMLButtonElement>(null);
  const wasChanging = useRef(false);
  const describedBy = [labelError === undefined ? null : `${id}-label-error`, valueError === undefined ? null : `${id}-value-error`]
    .filter(Boolean)
    .join(" ");
  const keepingSecret = field.kind === "hidden" && field.id !== null && !field.changing;

  // "Keep current" removes the input it was next to: put focus back on "Change".
  useEffect(() => {
    if (keepingSecret && wasChanging.current) changeButton.current?.focus();
    wasChanging.current = !keepingSecret;
  }, [keepingSecret]);

  const valueProps = {
    id: `${id}-value`,
    "aria-label": name,
    "aria-describedby": describedBy === "" ? undefined : describedBy,
    "aria-invalid": valueError === undefined ? undefined : (true as const),
    value: field.value,
    onChange: (event: { target: { value: string } }) => {
      onChange({ value: event.target.value });
    },
  };

  return (
    <li data-field-key={field.key} className="group/field flex flex-col gap-2 px-4 py-3">
      <div className="flex items-center gap-1.5">
        <input
          data-autofocus
          aria-label={`Label of field ${String(index + 1)}`}
          aria-invalid={labelError === undefined ? undefined : true}
          aria-describedby={labelError === undefined ? undefined : `${id}-label-error`}
          value={field.label}
          placeholder={FIELD_KINDS[field.kind].label}
          autoComplete="off"
          spellCheck={false}
          maxLength={ITEM_LIMITS.labelChars * 2}
          onChange={(event) => {
            onChange({ label: event.target.value });
          }}
          className={cn(
            "-ml-1.5 h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-xs font-medium text-fg-muted",
            "transition-colors duration-150 placeholder:text-fg-subtle hover:border-line-strong focus-visible:border-accent focus-visible:bg-canvas focus-visible:text-fg focus-visible:outline-offset-0",
            "aria-invalid:border-danger-text",
          )}
        />
        <span className="shrink-0 text-xs text-fg-subtle">
          {FIELD_KINDS[field.kind].label}
          {field.kind === "hidden" ? " · secret" : ""}
        </span>
        <div className="flex shrink-0 items-center transition-opacity duration-150 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/field:opacity-100 [@media(hover:hover)]:group-hover/field:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${name} up`}
            disabled={index === 0}
            onClick={() => {
              onMove(-1);
            }}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${name} down`}
            disabled={index === count - 1}
            onClick={() => {
              onMove(1);
            }}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
        </div>
        <Tip label={`Remove ${name}`}>
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${name}`} onClick={onRemove}>
            <X aria-hidden="true" />
          </Button>
        </Tip>
      </div>

      {keepingSecret ? (
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="font-mono tracking-[0.18em] text-fg-muted select-none">
            ••••••••••
          </span>
          <span className="sr-only">{name}: saved value, hidden</span>
          <Button
            ref={changeButton}
            size="sm"
            className="ml-auto"
            aria-label={`Change ${name}`}
            onClick={() => {
              onChange({ changing: true, value: "" });
            }}
          >
            Change
          </Button>
        </div>
      ) : field.kind === "hidden" ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                {...valueProps}
                type={revealed ? "text" : "password"}
                autoFocus={field.changing}
                placeholder={field.id === null ? "" : "New value"}
                className="pr-9 font-mono"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={revealed ? `Hide ${name}` : `Show ${name}`}
                aria-pressed={revealed}
                className="absolute top-1/2 right-0.5 -translate-y-1/2"
                onClick={onToggleRevealed}
              >
                {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </Button>
            </div>
            {onGenerate === null ? null : (
              <Button size="md" onClick={onGenerate}>
                <WandSparkles aria-hidden="true" />
                Generate
              </Button>
            )}
            {field.id !== null && field.changing ? (
              <Tip label="Keep the current value">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Keep the current ${name}`}
                  onClick={() => {
                    onChange({ changing: false, value: "" });
                  }}
                >
                  <Undo2 aria-hidden="true" />
                </Button>
              </Tip>
            ) : null}
          </div>
          {field.id !== null && field.changing ? (
            <p className="text-xs text-fg-subtle">Leave it empty to keep the current value.</p>
          ) : null}
        </div>
      ) : field.kind === "multiline" ? (
        <Textarea {...valueProps} rows={secureNoteBody ? 12 : 3} className={cn(secureNoteBody && "font-mono text-[13px]")} />
      ) : (
        <Input
          {...valueProps}
          inputMode={INPUT_MODES[field.kind]}
          placeholder={PLACEHOLDERS[field.kind] ?? ""}
        />
      )}
      {secureNoteBody ? <p className="text-xs text-fg-subtle">Markdown: **bold**, *italic*, # headings, - lists.</p> : null}

      {labelError === undefined ? null : (
        <p id={`${id}-label-error`} className="text-[13px] text-danger-text">
          {labelError}
        </p>
      )}
      {valueError === undefined ? null : (
        <p id={`${id}-value-error`} className="text-[13px] text-danger-text">
          {valueError}
        </p>
      )}
    </li>
  );
}
