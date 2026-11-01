import "@testing-library/jest-dom/vitest";

import { afterEach } from "vitest";

/** Defines `name` on `target` only if the environment lacks it. */
function polyfill(target: object, name: string, value: unknown) {
  if (!(name in target)) Object.defineProperty(target, name, { value, configurable: true, writable: true });
}

// Some tests run in the node environment (e.g. the build check): browser setup is skipped there.
if (typeof window !== "undefined") {
  const { clearMocks } = await import("@tauri-apps/api/mocks");
  const { cleanup } = await import("@testing-library/react");
  const { clearToasts } = await import("@/components/ui/use-toast");

  // jsdom lacks a few browser APIs that Radix, cmdk and Motion use.
  polyfill(
    globalThis,
    "ResizeObserver",
    class {
      observe() {
        /* no layout in jsdom */
      }
      unobserve() {
        /* no layout in jsdom */
      }
      disconnect() {
        /* no layout in jsdom */
      }
    },
  );
  polyfill(window, "matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
  polyfill(Element.prototype, "scrollIntoView", () => undefined);
  polyfill(Element.prototype, "hasPointerCapture", () => false);
  polyfill(Element.prototype, "setPointerCapture", () => undefined);
  polyfill(Element.prototype, "releasePointerCapture", () => undefined);

  afterEach(() => {
    cleanup();
    clearToasts();
    clearMocks();
  });
}
