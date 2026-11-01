/**
 * Item kinds, field kinds and the field templates each kind starts with
 * (ARCHITECTURE §5.10: "The item types are field templates the UI fills in").
 */
import {
  CreditCard,
  IdCard,
  KeyRound,
  type LucideIcon,
  Shapes,
  StickyNote,
} from "lucide-react";

import type { FieldKind, FieldRole, ItemKind } from "./ipc-types";

export interface FieldTemplate {
  label: string;
  kind: FieldKind;
  role: FieldRole | null;
}

export interface ItemKindInfo {
  label: string;
  /** Lower-case noun for sentences ("New login"). */
  noun: string;
  icon: LucideIcon;
  template: readonly FieldTemplate[];
}

const notes: FieldTemplate = { label: "Notes", kind: "multiline", role: "notes" };

export const ITEM_KINDS: Readonly<Record<ItemKind, ItemKindInfo>> = {
  login: {
    label: "Login",
    noun: "login",
    icon: KeyRound,
    template: [
      { label: "Username", kind: "text", role: "username" },
      { label: "Password", kind: "hidden", role: "password" },
      { label: "Website", kind: "url", role: "url" },
      notes,
    ],
  },
  secureNote: {
    label: "Secure Note",
    noun: "secure note",
    icon: StickyNote,
    // The Markdown body lives in the Notes-role field.
    template: [{ label: "Note", kind: "multiline", role: "notes" }],
  },
  card: {
    label: "Card",
    noun: "card",
    icon: CreditCard,
    template: [
      { label: "Cardholder", kind: "text", role: null },
      { label: "Number", kind: "hidden", role: null },
      { label: "Expiry", kind: "text", role: null },
      { label: "CVV", kind: "hidden", role: null },
      { label: "PIN", kind: "hidden", role: null },
      notes,
    ],
  },
  identity: {
    label: "Identity",
    noun: "identity",
    icon: IdCard,
    template: [
      { label: "Full name", kind: "text", role: null },
      { label: "Email", kind: "email", role: null },
      { label: "Phone", kind: "phone", role: null },
      { label: "Address", kind: "multiline", role: null },
      { label: "Date of birth", kind: "date", role: null },
      notes,
    ],
  },
  custom: {
    label: "Custom",
    noun: "custom item",
    icon: Shapes,
    template: [notes],
  },
};

/** In the order the UI offers them. */
export const ITEM_KIND_ORDER: readonly ItemKind[] = ["login", "secureNote", "card", "identity", "custom"];

export const FIELD_KINDS: Readonly<Record<FieldKind, { label: string; secret: boolean }>> = {
  text: { label: "Text", secret: false },
  hidden: { label: "Hidden", secret: true },
  url: { label: "URL", secret: false },
  email: { label: "Email", secret: false },
  phone: { label: "Phone", secret: false },
  date: { label: "Date", secret: false },
  multiline: { label: "Multiline", secret: false },
};

export const FIELD_KIND_ORDER: readonly FieldKind[] = [
  "text",
  "hidden",
  "url",
  "email",
  "phone",
  "date",
  "multiline",
];

/** Limits Rust enforces (efre-core item.rs); validate inline before saving. */
export const ITEM_LIMITS = {
  titleChars: 256,
  tags: 32,
  tagChars: 48,
  fields: 128,
  labelChars: 64,
  valueBytes: 256 * 1024,
  nicknameChars: 64,
} as const;
