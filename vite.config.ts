import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

import tauriConf from "./src-tauri/tauri.conf.json";

/**
 * Must never appear in a production bundle. Same string as MOCK_MARKER in
 * src/dev/mock-backend.ts (kept literal here: this file must not import app code).
 */
const MOCK_MARKER = "efre-dev-mock-backend";

/** The production CSP from tauri.conf.json, as one header value. */
const productionCsp = Object.entries(tauriConf.app.security.csp)
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join("; ");

/** Fails any non-mock build whose output contains dev-only code (src/dev, src/test). */
function noDevCodeInRelease(): Plugin {
  return {
    name: "efre:no-dev-code-in-release",
    apply: (_config, env) => env.command === "build" && env.mode !== "mock",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        const text =
          output.type === "chunk"
            ? output.code
            : typeof output.source === "string"
              ? output.source
              : new TextDecoder().decode(output.source);
        const devModules =
          output.type === "chunk" ? output.moduleIds.filter((id) => /[\\/]src[\\/](dev|test)[\\/]/.test(id)) : [];
        if (text.includes(MOCK_MARKER) || devModules.length > 0) {
          this.error(
            `dev-only code reached the production bundle in ${fileName}: ${devModules.join(", ") || MOCK_MARKER}`,
          );
        }
      }
    },
  };
}

// Dev servers bind to loopback only. `tauri dev` uses port 1420; `npm run dev:mock`
// (in-browser mock backend, no Tauri) uses 1430 or the next free port.
export default defineConfig(({ mode }) => {
  const mock = mode === "mock";
  return {
    plugins: [react(), tailwindcss(), noDevCodeInRelease()],
    clearScreen: false,
    resolve: { tsconfigPaths: true },
    server: {
      host: "127.0.0.1",
      port: mock ? 1430 : 1420,
      strictPort: !mock,
      watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    },
    // `npm run preview:mock` serves a mock build under the production CSP, to catch
    // anything the CSP would block (inline styles, eval, remote URLs) before Windows does.
    preview: {
      host: "127.0.0.1",
      port: 1431,
      strictPort: false,
      headers: { "Content-Security-Policy": productionCsp },
    },
    envPrefix: ["VITE_", "TAURI_ENV_"],
    build: {
      target: "chrome120",
      // A mock build never goes near dist/ (what Tauri bundles).
      outDir: mock ? "node_modules/.efre-mock-preview" : "dist",
      emptyOutDir: true,
      sourcemap: false,
      // Keep every asset as a file served by Tauri; nothing is inlined from or fetched to a remote origin.
      assetsInlineLimit: 0,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      restoreMocks: true,
    },
  };
});
