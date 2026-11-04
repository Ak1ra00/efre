import { describe, expect, it } from "vitest";

import { makeItemView } from "@/test/fixtures";

import { buildDraft, createForm, editForm, fingerprint, hasErrors, tagProblem, validate } from "./draft";

describe("editor form model", () => {
  it("starts a new item from its kind's template and drops empty new fields", () => {
    const form = createForm("login");
    expect(form.fields.map((f) => [f.label, f.kind, f.role])).toEqual([
      ["Username", "text", "username"],
      ["Password", "hidden", "password"],
      ["Website", "url", "url"],
      ["Notes", "multiline", "notes"],
    ]);
    const filled = {
      ...form,
      title: "  GitHub ",
      fields: form.fields.map((f) => (f.role === "password" ? { ...f, value: "pw" } : f)),
    };
    expect(buildDraft(filled)).toEqual({
      kind: "login",
      title: "GitHub",
      favorite: false,
      tags: [],
      fields: [{ id: null, label: "Password", kind: "hidden", role: "password", value: { set: "pw" } }],
    });
  });

  it("never asks for existing secrets: hidden fields stay 'keep' unless changed", () => {
    const view = makeItemView({ title: "GitHub", username: "octocat" });
    const form = editForm(view);
    const password = form.fields.find((f) => f.role === "password");
    expect(password?.value).toBe("");
    // Unchanged: everything is kept, and the missing Notes template field isn't saved.
    expect(buildDraft(form).fields.map((f) => [f.id, f.value])).toEqual([
      [1, "keep"],
      [2, "keep"],
      [3, "keep"],
    ]);
    // "Change" with nothing typed still keeps the stored value.
    const changingEmpty = { ...form, fields: form.fields.map((f) => (f.id === 2 ? { ...f, changing: true } : f)) };
    expect(buildDraft(changingEmpty).fields[1]?.value).toBe("keep");
    // A typed value replaces it; an edited text field is sent with its new value.
    const changed = {
      ...form,
      fields: form.fields.map((f) =>
        f.id === 2 ? { ...f, changing: true, value: "n3w" } : f.id === 1 ? { ...f, value: "hubot" } : f,
      ),
    };
    expect(buildDraft(changed).fields.map((f) => [f.id, f.value])).toEqual([
      [1, { set: "hubot" }],
      [2, { set: "n3w" }],
      [3, "keep"],
    ]);
    expect(fingerprint(changed)).not.toBe(fingerprint(form));
  });

  it("validates against Rust's limits", () => {
    const form = createForm("custom");
    expect(validate(form).title).toBe("Give this item a title.");
    expect(validate({ ...form, title: "x".repeat(257) }).title).toMatch(/256/);
    expect(validate({ ...form, title: "a\tb" }).title).toMatch(/one line/);
    expect(hasErrors(validate({ ...form, title: "ok" }))).toBe(false);
    const longLabel = { ...form, title: "ok", fields: form.fields.map((f) => ({ ...f, label: "l".repeat(65) })) };
    expect(hasErrors(validate(longLabel))).toBe(true);
    expect(tagProblem("work", ["Work"])).toMatch(/already/);
    expect(tagProblem("t".repeat(49), [])).toMatch(/48/);
    expect(tagProblem("ok", Array.from({ length: 32 }, (_, i) => `t${String(i)}`))).toMatch(/32/);
  });

  it("adds a tag still typed in the tag input when saving", () => {
    const form = { ...createForm("secureNote"), title: "Plan", tags: ["home"], tagDraft: " travel " };
    expect(buildDraft(form).tags).toEqual(["home", "travel"]);
  });
});
