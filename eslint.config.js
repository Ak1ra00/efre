// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const storage = "efre never uses browser storage (ARCHITECTURE §8.3).";
const network = "efre makes no network requests (ARCHITECTURE §10).";
const clipboard = "Copying happens in Rust (ipc.copyField / copyRole / copyGenerated), never in JS.";

export default defineConfig(
  {
    ignores: ["dist/**", "src-tauri/**", "target/**", "coverage/**", "node_modules/**"],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  reactHooks.configs.flat["recommended-latest"],
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Security invariants (AGENTS.md, docs/FRONTEND.md): no browser storage, no network, no JS clipboard.
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: storage },
        { name: "sessionStorage", message: storage },
        { name: "indexedDB", message: storage },
        { name: "caches", message: storage },
        { name: "cookieStore", message: storage },
        { name: "fetch", message: network },
        { name: "XMLHttpRequest", message: network },
        { name: "WebSocket", message: network },
        { name: "EventSource", message: network },
        { name: "WebTransport", message: network },
        { name: "RTCPeerConnection", message: network },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "localStorage", message: storage },
        { object: "window", property: "sessionStorage", message: storage },
        { object: "window", property: "indexedDB", message: storage },
        { object: "window", property: "caches", message: storage },
        { object: "document", property: "cookie", message: storage },
        { object: "navigator", property: "storage", message: storage },
        { object: "navigator", property: "serviceWorker", message: storage },
        { object: "window", property: "fetch", message: network },
        { object: "window", property: "open", message: "efre never opens windows or URLs." },
        { object: "navigator", property: "sendBeacon", message: network },
        { object: "navigator", property: "clipboard", message: clipboard },
        { object: "document", property: "execCommand", message: clipboard },
        { object: "navigator", property: "credentials", message: "WebAuthn runs in Rust (webauthn.dll), not in the webview." },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@tauri-apps/plugin-*"], message: "efre installs no Tauri plugins in the webview." },
          ],
        },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
    },
  },
  {
    // App code reaches Rust only through src/lib/ipc.ts, and never touches the dev mock.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/ipc.ts", "src/dev/**", "src/test/**", "src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@tauri-apps/api/core", importNames: ["invoke"], message: "Use the typed wrappers in @/lib/ipc." },
            {
              name: "@tauri-apps/api/event",
              importNames: ["listen", "once", "emit", "emitTo"],
              message: "Use listenEvent / useIpcEvent from @/lib.",
            },
            { name: "@tauri-apps/api/mocks", message: "Mocks are for src/dev and tests only." },
          ],
          patterns: [
            { group: ["@tauri-apps/plugin-*"], message: "efre installs no Tauri plugins in the webview." },
            { group: ["@/dev/*", "**/dev/*", "@/test/*", "**/test/*"], message: "Dev/test-only code must not be imported by the app." },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
