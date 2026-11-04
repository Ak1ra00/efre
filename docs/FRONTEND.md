# efre — frontend guide

The React UI in `src/`. The IPC contract is `docs/IPC.md`; the security rules are
`AGENTS.md` and ARCHITECTURE §8.3. This file covers who owns what, the seams between
features, the design tokens, and how to preview the UI without Windows or a YubiKey.

## Folder ownership (phase 4)

| Path | Owner | Notes |
|---|---|---|
| `src/vault/**` | E2 | Vault UI: sidebar, virtualized list, item detail/editor, search, trash. Entry: `VaultScreen.tsx`. |
| `src/setup/**` | E3 | First-run wizard. Entry: `SetupWizard.tsx`. |
| `src/unlock/**` | E3 | `UnlockScreen.tsx`, `UnsupportedScreen.tsx`. |
| `src/settings/**` | E3 | `SettingsDialog.tsx` (keys, timers, vault folder, security info). |
| `src/palette/**` | E3 | `CommandPalette.tsx` (Ctrl+K). |
| `src/generator/**` | E3 | `GeneratorDialog.tsx`. |
| `src/app/ShortcutSheet.tsx` | E3 | The `?` sheet. |
| everything else in `src/` | shared (E0) | `app/`, `components/`, `lib/`, `dev/`, `test/`. Change only by agreement. |

The files above are placeholders: replace them freely, but keep each path and export
name, because `src/app/App.tsx` imports them. Put feature-only components and hooks
inside your own folder. If you need a new shared primitive, add a new file in
`src/components/ui/` (never edit an existing one without agreement).

## How the app is wired

`src/app/App.tsx` is a state machine on `app_status`:
`loading → unsupported | setup | locked | unlocked`. Each phase screen mounts fresh: the
UI-state provider and command registry are keyed by phase, so locking unmounts the
whole unlocked tree and with it every piece of decrypted data in JS. Keep vault state in
React (component state or a context inside `VaultScreen`), never at module level.

While unlocked, the shell renders `SingleKeyBanner`, then `VaultScreen` (fills the rest
of the window), and mounts `SettingsDialog`, `CommandPalette`, `GeneratorDialog` and
`ShortcutSheet` globally. It also pings `activity` (throttled to one per 15 s) on
pointer, keyboard and wheel input, and binds Ctrl+K (palette), Ctrl+L (lock) and `?`
(shortcut sheet).

### Seams

| Import | API |
|---|---|
| `@/app/app-status` | `useAppStatus(): { status, phase, error, refreshStatus(), setStatus(s), lock() }`; `useStatus(): AppStatus` (non-null, phase screens only). Commands that return an `AppStatus` (setup_*, unlock) go to `setStatus`; call `refreshStatus()` after anything that changes keys. |
| `@/app/ui-state` | `useUIState(): { settingsOpen, settingsSection, openSettings(section?), closeSettings(), setSettingsSection(s), paletteOpen, setPaletteOpen(b), shortcutsOpen, setShortcutsOpen(b), generatorOpen, generatorOnUse, requestGenerator(onUse?), closeGenerator(), overlayOpen }`. `SettingsSection = "keys" \| "timers" \| "vault" \| "security"`. One overlay at a time; actions are stable. |
| `@/app/commands` | `useRegisterCommands(commands)`, `useCommands()`, `COMMAND_GROUPS` (`Item, New, Go to, Vault, Settings, Help`). `Command = { id, title, group, keywords?, shortcut?, icon?, enabled?, run }`. `shortcut` is display only; `run` always calls the latest closure. |
| `@/app/use-shortcut` | `useShortcut(combo \| combos, handler, { enabled?, allowInInputs?, preventDefault?, allowRepeat? })`. Windows notation (`"Ctrl+N"`, `"Esc"`, `"?"`). Skips events already handled (`defaultPrevented`) and, unless `allowInInputs`, keystrokes in text fields. |
| `@/app/toast-error` | `toastError(err, title?)`: a red toast with `friendlyError` copy. |
| `@/components/ui/use-toast` | `toast({ title, description?, variant?, action?: { label, onClick }, duration? })` returns `{ id, dismiss, update }`; `useToast()`. Use an action for "Undo". |
| `@/lib/ipc` | `ipc.*` (one typed function per command), `listenEvent`, `onKeyStep`, `onLocked`, `IpcError`, `isIpcError`, `ipcErrorCode`, `friendlyError(err) → { code, title, description }`, `describeKeyStep(step)`. |
| `@/lib/use-ipc-event` | `useIpcEvent("key-step", handler, enabled?)`. |
| `@/lib/ipc-types` | Every DTO, `IpcCommands`, `COMMAND_NAMES`, `PROMPTING_COMMANDS`, `IPC_ERROR_CODES`. |
| `@/lib/items` | `ITEM_KINDS` (label, icon, field template per kind), `ITEM_KIND_ORDER`, `FIELD_KINDS`, `ITEM_LIMITS`. |
| `@/lib/defaults` | IPC.md defaults and presets: `DEFAULT_PASSWORD_OPTIONS`, `DEFAULT_PASSPHRASE_OPTIONS`, `AUTO_LOCK_PRESETS`, `CLIPBOARD_PRESETS`, `REVEAL_SECONDS`, `strengthLabel()`, `formatMinutes()`. |

Shell commands already registered (don't duplicate): `app.lock`, `app.generator`,
`app.open-vault-folder`, `app.settings`, `app.shortcuts`. E2 owns Ctrl+N, Ctrl+F,
Ctrl+C, Ctrl+B and Esc. Never bind Ctrl+P, Ctrl+Shift+P, Ctrl+U or Ctrl+J: the shell
swallows them so the WebView can't print or show its own pages.

Notes for specific features:
- **Palette (cmdk):** render `<Command vimBindings={false}>` inside our `DialogContent`,
  not `Command.Dialog`. With vim bindings on, cmdk swallows Ctrl+K.
- **Secure notes (react-markdown):** raw HTML in Markdown is shown as text, never
  rendered; pass `skipHtml` to drop it. Also pass `disallowedElements={["img"]}` and
  render links as plain text (efre never opens URLs, and the CSP blocks remote images).
- **Virtualized list:** give `@tanstack/react-virtual` a `ScrollArea` (native scrolling)
  as the scroll element through its `ref`.
- **Selection:** a selected row needs a visible cue besides its background (e.g. an
  accent bar), so state doesn't rely on a 1.3:1 colour difference.

### YubiKey prompts (`src/unlock/key-prompt.tsx`, E3)

Every prompting command (setup_enroll_key, unlock, add_key, rename_key, remove_key) runs
through `useKeyPrompt().run(() => ipc.…)`, which never rejects: it resolves with
`{ ok: true, value }` or `{ ok: false, error, cancelledByUser }`. `<KeyPromptOverlay
prompt={…} total rows note enrolledKeys />` shows what Windows asks for from the
`key-step` events (`describeKeyStep` plus one line per step), progress rows for multi-prompt
flows, and Cancel/Esc (`cancel_prompt`, re-sent if a new prompt opens). It sits in the
upper part of the window so it stays readable above the Windows Security dialog. A Cancel
the user pressed is reported as `cancelledByUser` so no error is shown;
`keyErrorCopy(err, flow)` (`src/unlock/key-errors.tsx`) gives flow-specific copy for the
rest (for example `authn.cancelled` also covers "Windows didn't recognise this key").

## Vault UI (`src/vault/`)

- **State:** `vault-context.tsx` (`VaultProvider`, `useVault()`) holds the list metadata,
  view, query, sort, selection and editor. `vault-reducer.ts` has every transition as a
  pure function. All of it unmounts on lock.
- **Layout** (`use-layout.ts`, by window width): at 1100 px and wider, sidebar, list and
  detail. From 720 px, the sidebar becomes an icon rail that can be expanded. Below
  720 px, the rail plus one pane at a time: the list, then the detail with Back (Esc
  also goes back).
- **Search** (`search.ts`): fzy-style fuzzy matching over title, username, tags and the
  kind name. It ignores case and accents, and every word must match. The best match is
  listed and selected first, and ties keep the chosen sort.
- **List:** a `listbox` driven by `aria-activedescendant`, with the search field as its
  combobox. ↑/↓/Home/End/PageUp/PageDown move, Enter opens, and typing in the list
  starts a search. Arrows move the selection; in the wide layouts the detail follows it.
- **Secrets:** hidden values are fetched only by Reveal. They show for 10 s with a
  countdown, can't be selected, and hide when efre loses focus or the field unmounts.
  The editor never fetches secrets: an existing hidden field goes back as `"keep"`
  unless the user chooses Change and types a value (empty still means keep). New fields
  left empty aren't saved. A kind's template fields that an item lacks are offered
  again when editing.
- **Copy:** `copy_field` for field buttons, and `copy_role` for Ctrl+C (password) and
  Ctrl+B (username). Ctrl+C is left alone when text is selected or focus is in a text
  field other than the vault search.
- **Shortcuts:** Ctrl+N (kind menu; 1–5 pick a kind), Ctrl+F, Ctrl+C, Ctrl+B and Esc.
- **Palette:** `vault.new.*` and `vault.new`, `vault.go.*` (views, tags, trash),
  `vault.search`, `vault.empty-trash`, and `vault.item.*` for the selected item.
- **Menus** are `modal={false}`. That avoids Radix's scroll-lock `<style>`, which the CSP
  blocks, and a focus trap that fights the editor's initial focus.
- **Seam for overlays:** when a palette command opens the editor, the palette's
  close-autofocus shouldn't move focus back to where it was.

## Primitives (`src/components/ui/`)

Accessible, shadcn-style, built on `radix-ui` and `class-variance-authority`:
`alert`, `alert-dialog`, `badge`, `button` (`variant`: primary, secondary, ghost, danger,
link; `size`: sm, md, lg, icon, icon-sm; `loading`), `checkbox`, `dialog` (with
`DialogBody`; `size`: sm–xl), `dropdown-menu` (`DropdownMenuShortcut combo`),
`empty-state`, `field` (label + hint + inline error, ids wired), `input`, `kbd`
(`KbdCombo combo="Ctrl+K"`), `label`, `popover`, `scroll-area`, `select`, `separator`,
`skeleton`, `slider`, `spinner`, `switch`, `tabs`, `textarea`, `toast` (`Toaster`),
`tooltip` (`Tip label shortcut`). `@/components/brand/logo` has `EfreMark`. See them all
at `/?gallery` in the mock preview.

## Design tokens (`src/index.css`)

Tailwind v4 `@theme`; the default palette is removed, so only these colours exist.

- **Surfaces:** `canvas` (window) → `surface` (panes) → `elevated` (cards, popovers,
  dialogs); `hover`, `selected`; `scrim` behind dialogs.
- **Lines:** `line` (decorative 1px), `line-strong`, `control` / `control-hover` (borders of
  inputs, checkboxes, switches: 3:1 against every surface).
- **Text:** `fg` (≥ 12:1), `fg-muted` (≥ 6:1), `fg-subtle` (≥ 4.6:1, also placeholders),
  `fg-disabled` (disabled only).
- **Accent:** `accent` #8b93ff (with `accent-fg` text on it, 7:1), `accent-hover`,
  `accent-active`, `accent-text` (accent text on dark), `accent-soft`, `ring`.
- **Status:** `danger` (solid, white text 5.2:1), `danger-text`, `danger-soft`;
  `success-text` / `-soft`; `warning-text` / `-soft`. For meaning only.
- **Type:** Inter Variable (bundled), 14 px body; `font-mono` is Cascadia/Consolas.
- **Shape and depth:** 8 px rhythm (use even spacing steps), radius `md` for controls,
  `lg` for popovers, `xl` for dialogs; shadows `shadow-soft`, `shadow-popover`,
  `shadow-dialog`, `shadow-highlight`.
- **Motion:** 150–200 ms; `animate-fade-in/out`, `pop-in/out`, `dialog-in/out`,
  `toast-in/out`. `prefers-reduced-motion` removes it (spinners keep turning, slowly);
  Motion components follow `MotionConfig reducedMotion="user"`.
- **Focus:** every focusable element gets a 2 px accent outline on `:focus-visible`.

## Security rules for UI code (ESLint enforces them)

- No browser storage: `localStorage`, `sessionStorage`, IndexedDB, Cache API, cookies.
- No network APIs: `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, WebRTC.
- No JS clipboard: `navigator.clipboard` and `document.execCommand` are banned. Copy
  with `ipc.copyField`, `ipc.copyRole` or `ipc.copyGenerated`; Rust clears it later.
- Reach Rust only through `@/lib/ipc` (`invoke` and `listen` are banned elsewhere), and
  never import `src/dev` or `src/test` from app code.
- No `eval`, `new Function` or `javascript:` URLs. No Tauri plugins in the webview.
- Secrets reach JS only through `ipc.revealField` (hide again after `REVEAL_SECONDS`)
  or while the user types them. Never log them, put them in toasts, or keep them in
  state longer than the view that shows them.
- The CSP is `style-src 'self'`: no `<style>` elements and no `style="…"` in markup.
  React's `style` prop is fine (it uses the CSSOM). Don't use libraries that inject
  stylesheets, and don't use Motion's `AnimatePresence mode="popLayout"` (it injects
  one). Radix's modal scroll lock and Select also insert a tiny `<style>`; the CSP
  blocks it and `index.css` carries the same rules, so the only effect is a console
  message.

## Mock preview (no Tauri, no YubiKey)

```sh
npm run dev:mock        # http://127.0.0.1:1430 (or the next free port), hot reload
npm run preview:mock    # a mock build served under the production CSP (port 1431)
```

`src/dev/mock-backend.ts` implements the whole IPC contract in memory: two keys,
realistic items of all five kinds, settings, generator, idle auto-lock, simulated
Windows Security prompts with `key-step` events. Scenarios come from the URL:

| Param | Effect |
|---|---|
| `phase=setup\|locked\|unlocked\|unsupported` | Start phase (default `locked`). |
| `keys=1` | One enrolled key (single-key banner). |
| `empty=1` / `items=2000` | Empty vault / extra generated logins. |
| `prompt=300` | Prompt duration in ms (default 1200). |
| `fail=authn.pinBlocked` | The next prompt fails with that code. |
| `reason=idle` | `lastLockReason`. |
| `idle=20` | Idle auto-lock after 20 s (exercises the activity pinger). |
| `gallery` | The UI kit instead of the app. |
| `log=1` | Log command names to the console. |

`window.__efreMock` drives it at runtime: `lock("unplug")`, `failNext("authn.timeout")`,
`setPromptDelay(ms)`, `emit(event, payload)`. Locking doesn't reload the page (that would
lose the in-memory vault); the app's `locked` handler resets the UI either way.

The mock only loads when `MODE === "mock"`. A production build fails if its marker or
any `src/dev`/`src/test` module reaches the bundle (`vite.config.ts`), and
`src/dev/mock-exclusion.test.ts` checks the same in `npm test`.

### Screenshots with Playwright

Chromium is preinstalled; `require('playwright')` works from any directory. Never run
`playwright install`. With `npm run dev:mock` running:

```js
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  await page.goto("http://127.0.0.1:1430/?phase=unlocked&keys=1", { waitUntil: "networkidle" });
  await page.keyboard.press("Control+k");
  await page.screenshot({ path: "/path/outside/the/repo/palette.png" });
  await browser.close();
})();
```

Keep screenshots out of the repository.

## Tests

Vitest + Testing Library (`npm test`). `src/test/ipc-mock.ts` scripts commands and
emits events:

```ts
const ipc = mockIpc()
  .on("app_status", makeStatus({ phase: "unlocked" }))
  .on("get_item", ({ id }) => makeItemView({ id }))
  .failOnce("copy_role", "notFound");
render(<App />);
await ipc.emit("locked", { reason: "idle" });
expect(ipc.callsTo("copy_role")).toEqual([{ id, role: "password" }]);
```

Builders for DTOs are in `src/test/fixtures.ts`. Unscripted commands reject with
`internal` and are listed in `ipc.unhandled`.
