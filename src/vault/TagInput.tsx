import { X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useId, useRef } from "react";

import type { FieldControlProps } from "@/components/ui/field";
import { cn } from "@/lib/utils";

import { tagProblem } from "./draft";

/** Generous cap on the typed text (a tag is at most 48 characters; longer is an error). */
const ITEM_TAG_INPUT_MAX = 200;

interface TagInputProps extends FieldControlProps {
  tags: readonly string[];
  draft: string;
  /** Existing tags in the vault (suggestions; their spelling is reused). */
  suggestions: readonly string[];
  onTagsChange: (tags: string[]) => void;
  onDraftChange: (draft: string) => void;
  /** A tag couldn't be added (shown inline by the surrounding Field), or null to clear. */
  onProblem: (problem: string | null) => void;
}

/**
 * Tags as chips. Enter or a comma adds what's typed; Backspace in the empty input removes
 * the last tag; pasting "a, b" adds both. Suggestions come from tags already in use.
 */
export function TagInput({
  tags,
  draft,
  suggestions,
  onTagsChange,
  onDraftChange,
  onProblem,
  ...control
}: TagInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const add = (raw: readonly string[]): boolean => {
    let next = [...tags];
    for (const piece of raw) {
      const typed = piece.trim();
      if (typed === "") continue;
      // Reuse an existing tag's spelling ("Work" → "work"), so the sidebar has one entry.
      const tag = suggestions.find((s) => s.toLowerCase() === typed.toLowerCase()) ?? typed;
      const problem = tagProblem(tag, next);
      if (problem !== null) {
        onProblem(problem);
        onTagsChange(next);
        return false;
      }
      next = [...next, tag];
    }
    onProblem(null);
    onTagsChange(next);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.key === "Enter" || event.key === ",") && draft.trim() !== "") {
      event.preventDefault();
      if (add([draft])) onDraftChange("");
      return;
    }
    if (event.key === ",") {
      event.preventDefault();
      return;
    }
    if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      event.preventDefault();
      onProblem(null);
      onTagsChange(tags.slice(0, -1));
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!text.includes(",") && !text.includes("\n")) return;
    event.preventDefault();
    const pieces = (draft + text).split(/[,\n]/);
    const last = pieces.pop() ?? "";
    if (add(pieces)) onDraftChange(last.trimStart());
  };

  const available = suggestions.filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()));

  return (
    <div
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
      className={cn(
        "flex min-h-8 w-full flex-wrap items-center gap-1.5 rounded-md border border-control bg-canvas/60 px-1.5 py-1",
        "transition-[border-color,background-color] duration-150 hover:border-control-hover",
        "focus-within:border-accent focus-within:bg-canvas focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-ring",
        control["aria-invalid"] === true && "border-danger-text",
      )}
    >
      {tags.length === 0 ? null : (
        <ul aria-label="Tags" className="contents">
          {tags.map((tag) => (
            <li
              key={tag}
              className="inline-flex h-6 max-w-full items-center gap-0.5 rounded-md bg-hover pr-0.5 pl-2 text-xs font-medium text-fg"
            >
              <span className="truncate">{tag}</span>
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => {
                  onProblem(null);
                  onTagsChange(tags.filter((t) => t !== tag));
                  inputRef.current?.focus();
                }}
                className="inline-flex size-5 items-center justify-center rounded text-fg-subtle transition-colors duration-150 hover:bg-selected hover:text-fg focus-visible:outline-offset-0"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        {...control}
        type="text"
        list={available.length === 0 ? undefined : listId}
        value={draft}
        placeholder={tags.length === 0 ? "Add a tag" : "Add another"}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={ITEM_TAG_INPUT_MAX}
        onChange={(event) => {
          onProblem(null);
          onDraftChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="h-6 min-w-28 flex-1 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-fg-subtle [&::-webkit-calendar-picker-indicator]:hidden"
      />
      {available.length === 0 ? null : (
        <datalist id={listId}>
          {available.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
