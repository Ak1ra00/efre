// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/**", "src-tauri/**", "target/**", "coverage/**", "node_modules/**"] },
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
      // Security invariant (ARCHITECTURE.md §8.3): nothing is ever persisted in browser storage.
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "efre never uses browser storage." },
        { name: "sessionStorage", message: "efre never uses browser storage." },
        { name: "indexedDB", message: "efre never uses browser storage." },
        { name: "fetch", message: "efre makes no network requests." },
        { name: "XMLHttpRequest", message: "efre makes no network requests." },
        { name: "WebSocket", message: "efre makes no network requests." },
        { name: "EventSource", message: "efre makes no network requests." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "localStorage", message: "efre never uses browser storage." },
        { object: "window", property: "sessionStorage", message: "efre never uses browser storage." },
        { object: "window", property: "indexedDB", message: "efre never uses browser storage." },
        { object: "window", property: "fetch", message: "efre makes no network requests." },
        { object: "navigator", property: "sendBeacon", message: "efre makes no network requests." },
        { object: "navigator", property: "clipboard", message: "Copying happens in Rust, never in JS." },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
