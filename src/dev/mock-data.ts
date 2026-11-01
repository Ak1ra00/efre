/**
 * Sample vault for `npm run dev:mock`: fictional people, test card numbers, no real
 * secrets. Covers all five item kinds, favourites, tags, a password-less login, trash.
 */
import type { FieldKind, FieldRole, ItemKind, KeyInfo } from "@/lib/ipc-types";

export interface MockField {
  id: number;
  label: string;
  kind: FieldKind;
  role: FieldRole | null;
  value: string;
}

export interface MockItem {
  id: string;
  kind: ItemKind;
  title: string;
  favorite: boolean;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  fields: MockField[];
  nextFieldId: number;
}

const DAY = 86_400;

export function randomHexId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type FieldSpec = [label: string, kind: FieldKind, role: FieldRole | null, value: string];

interface ItemSpec {
  kind: ItemKind;
  title: string;
  tags?: string[];
  favorite?: boolean;
  /** Created this many days ago. */
  age: number;
  /** Last edited this many days ago (default: same as age). */
  edited?: number;
  /** In the trash since this many days ago. */
  trashed?: number;
  fields: FieldSpec[];
}

function build(spec: ItemSpec, now: number): MockItem {
  const createdAt = now - spec.age * DAY;
  const fields = spec.fields.map(([label, kind, role, value], i) => ({ id: i + 1, label, kind, role, value }));
  return {
    id: randomHexId(),
    kind: spec.kind,
    title: spec.title,
    favorite: spec.favorite ?? false,
    tags: spec.tags ?? [],
    createdAt,
    updatedAt: now - (spec.edited ?? spec.age) * DAY,
    trashedAt: spec.trashed === undefined ? null : now - spec.trashed * DAY,
    fields,
    nextFieldId: fields.length + 1,
  };
}

const login = (username: string, password: string | null, url: string | null, notes = ""): FieldSpec[] => [
  ["Username", "text", "username", username],
  ...(password === null ? [] : ([["Password", "hidden", "password", password]] as FieldSpec[])),
  ...(url === null ? [] : ([["Website", "url", "url", url]] as FieldSpec[])),
  ["Notes", "multiline", "notes", notes],
];

const EMERGENCY_PLAN = `# If a YubiKey is lost

1. Unlock efre with the **backup key** (it lives in the fire safe).
2. Open **Settings → YubiKeys** and choose *Remove lost key*.
3. Order a replacement and enroll it as the new backup.

> Copies of \`vault.efre\` made before the removal can still be opened
> with the lost key. Delete them and make a fresh copy.

## Contacts
- Bank fraud line: on the back of the card
- Registrar support: \`support@registrar.example\`
`;

const RECOVERY_CODES = `GitHub recovery codes (each works once):

- \`4f9a2-77c1e\`
- \`b3d0e-19a6f\`
- \`0c8e4-5b2d9\`
- \`e61f7-a03c4\`

Generated 2026-03-14. Regenerate after using two of them.`;

const GUEST_WIFI = `**Network:** Tilelli-Guest
**Password:** ask at the door, or scan the card on the fridge.

Guests are isolated from the home network.`;

const SPECS: ItemSpec[] = [
  {
    kind: "login",
    title: "GitHub",
    tags: ["dev", "work"],
    favorite: true,
    age: 410,
    edited: 12,
    fields: login("amastan-dev", "x7#Lp2!vQ9&mZr4@Tn", "https://github.com/login", "Recovery codes: see the secure note."),
  },
  {
    kind: "login",
    title: "Proton Mail",
    tags: ["email", "personal"],
    favorite: true,
    age: 380,
    edited: 40,
    fields: login("amastan@proton.me", "sorrel-Tundra-58-glide-Ivory", "https://account.proton.me"),
  },
  {
    kind: "login",
    title: "Hetzner Cloud",
    tags: ["infra", "work"],
    age: 300,
    edited: 3,
    fields: login("ops@example.com", "Hz!9qT3w$Xb7Lm2p", "https://console.hetzner.cloud"),
  },
  {
    kind: "login",
    title: "Northwind Bank",
    tags: ["finance"],
    favorite: true,
    age: 720,
    edited: 90,
    fields: login("40812233", "Nw-7731-quartz-Lagoon", "https://online.northwind-bank.example", "Customer number is the username."),
  },
  {
    kind: "login",
    title: "Steam",
    tags: ["games"],
    age: 650,
    fields: login("amastan_plays", "s7eam-Is-Fun-2019!", "https://store.steampowered.com"),
  },
  {
    kind: "login",
    title: "Figma",
    tags: ["design", "work"],
    age: 200,
    edited: 25,
    fields: login("amastan@example.com", "F1gma#Frames&Vectors", "https://www.figma.com"),
  },
  {
    kind: "login",
    title: "AWS root account",
    tags: ["infra", "work"],
    age: 520,
    edited: 60,
    fields: login("root@example.com", "Aw$-root-9d2f-K8xq-Pz41", "https://signin.aws.amazon.com", "Hardware MFA lives with the backup key."),
  },
  {
    kind: "login",
    title: "Router admin",
    tags: ["home"],
    age: 900,
    fields: login("admin", "R0uter!Admin#4410", "http://192.168.1.1"),
  },
  {
    kind: "login",
    title: "Mastodon",
    tags: ["social"],
    age: 150,
    fields: login("@amastan@hachyderm.io", "toot-Toot-Bramble-77", "https://hachyderm.io"),
  },
  {
    kind: "login",
    title: "Old forum account",
    age: 1500,
    fields: login("amastan", null, "https://forum.example.org", "Password lost; account kept for the username."),
  },
  {
    kind: "secureNote",
    title: "Emergency plan",
    tags: ["important"],
    favorite: true,
    age: 400,
    edited: 30,
    fields: [["Note", "multiline", "notes", EMERGENCY_PLAN]],
  },
  {
    kind: "secureNote",
    title: "GitHub recovery codes",
    tags: ["dev"],
    age: 230,
    fields: [["Note", "multiline", "notes", RECOVERY_CODES]],
  },
  {
    kind: "secureNote",
    title: "Guest Wi-Fi card",
    tags: ["home"],
    age: 60,
    fields: [["Note", "multiline", "notes", GUEST_WIFI]],
  },
  {
    kind: "card",
    title: "Visa · Everyday",
    tags: ["finance"],
    age: 340,
    edited: 20,
    fields: [
      ["Cardholder", "text", null, "A. AIT ALI"],
      ["Number", "hidden", null, "4111 1111 1111 1111"],
      ["Expiry", "text", null, "08/29"],
      ["CVV", "hidden", null, "123"],
      ["PIN", "hidden", null, "4821"],
      ["Notes", "multiline", "notes", "Contactless limit raised in the app."],
    ],
  },
  {
    kind: "card",
    title: "Mastercard · Travel",
    tags: ["finance", "travel"],
    age: 120,
    fields: [
      ["Cardholder", "text", null, "AMASTAN AIT ALI"],
      ["Number", "hidden", null, "5555 5555 5555 4444"],
      ["Expiry", "text", null, "03/28"],
      ["CVV", "hidden", null, "737"],
      ["PIN", "hidden", null, "9034"],
      ["Notes", "multiline", "notes", ""],
    ],
  },
  {
    kind: "identity",
    title: "Personal",
    tags: ["personal"],
    age: 800,
    edited: 45,
    fields: [
      ["Full name", "text", null, "Amastan Ait Ali"],
      ["Email", "email", null, "amastan@example.com"],
      ["Phone", "phone", null, "+33 6 12 34 56 78"],
      ["Address", "multiline", null, "12 Rue des Lilas\n75011 Paris\nFrance"],
      ["Date of birth", "date", null, "1994-04-12"],
      ["Notes", "multiline", "notes", ""],
    ],
  },
  {
    kind: "identity",
    title: "Passport",
    tags: ["travel", "important"],
    age: 500,
    fields: [
      ["Full name", "text", null, "AIT ALI, Amastan"],
      ["Passport number", "hidden", null, "19FV28841"],
      ["Issued", "date", null, "2021-06-02"],
      ["Expires", "date", null, "2031-06-01"],
      ["Notes", "multiline", "notes", "Renew six months before travel."],
    ],
  },
  {
    kind: "custom",
    title: "Home Wi-Fi",
    tags: ["home"],
    favorite: true,
    age: 700,
    fields: [
      ["Network", "text", null, "Tilelli-5G"],
      ["Password", "hidden", "password", "correct-horse-battery-staple"],
      ["Security", "text", null, "WPA3 Personal"],
    ],
  },
  {
    kind: "custom",
    title: "Server: build-01",
    tags: ["infra"],
    age: 90,
    edited: 2,
    fields: [
      ["Host", "url", "url", "ssh://build-01.internal"],
      ["IP address", "text", null, "10.0.4.21"],
      ["User", "text", "username", "deploy"],
      ["Password", "hidden", "password", "bld-01!Ssh#7729"],
      ["Notes", "multiline", "notes", "Key-based login preferred.\nPassword only for the console."],
    ],
  },
  {
    kind: "custom",
    title: "Affinity Photo licence",
    tags: ["software"],
    age: 330,
    fields: [
      ["Licence key", "hidden", null, "AF2Q-9X7L-MP44-RT81"],
      ["Email", "email", null, "amastan@example.com"],
      ["Purchased", "date", null, "2025-11-28"],
    ],
  },
  {
    kind: "login",
    title: "Dropbox (old)",
    age: 1100,
    trashed: 5,
    fields: login("amastan@example.com", "dbx-Old-2020!", "https://www.dropbox.com"),
  },
  {
    kind: "card",
    title: "Expired debit card",
    tags: ["finance"],
    age: 1300,
    trashed: 21,
    fields: [
      ["Cardholder", "text", null, "A. AIT ALI"],
      ["Number", "hidden", null, "4000 0566 5566 5556"],
      ["Expiry", "text", null, "01/24"],
      ["CVV", "hidden", null, "321"],
      ["PIN", "hidden", null, "1180"],
      ["Notes", "multiline", "notes", ""],
    ],
  },
];

/** The sample vault, plus `extra` generated logins for testing the virtualized list. */
export function sampleItems(now: number, extra = 0): MockItem[] {
  const items = SPECS.map((spec) => build(spec, now));
  for (let i = 1; i <= extra; i++) {
    items.push(
      build(
        {
          kind: "login",
          title: `Example site ${String(i).padStart(4, "0")}`,
          tags: i % 3 === 0 ? ["bulk"] : [],
          age: (i % 700) + 1,
          fields: login(`user${String(i)}@example.com`, `bulk-${String(i)}-password`, `https://site${String(i)}.example.com`),
        },
        now,
      ),
    );
  }
  return items;
}

export function sampleKeys(now: number): KeyInfo[] {
  return [
    {
      id: randomHexId(),
      nickname: "YubiKey 5C NFC",
      enrolledAt: now - 412 * DAY,
      aaguid: "a25342c0-3cdc-4414-8e46-f4807fca511c",
    },
    {
      id: randomHexId(),
      nickname: "Backup · YubiKey 5 Nano",
      enrolledAt: now - 412 * DAY + 300,
      aaguid: "ee882879-721c-4913-9775-3dfcce97072a",
    },
  ];
}
