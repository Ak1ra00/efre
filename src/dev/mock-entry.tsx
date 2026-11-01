/** DEV ONLY (`npm run dev:mock`): installs the mock backend; `?gallery` shows the UI kit. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installMockBackend, MOCK_MARKER, type MockBackend, scenarioFromUrl } from "./mock-backend";

/** Returns true when it rendered something itself (the gallery) instead of the app. */
export function startMockPreview(root: HTMLElement): boolean {
  const backend = installMockBackend(scenarioFromUrl(window.location.search));
  (window as unknown as { __efreMock?: MockBackend }).__efreMock = backend;
  console.info(
    `[${MOCK_MARKER}] Mock backend active (phase=${backend.scenario.phase}). Try ?phase=setup|locked|unlocked|unsupported, ?keys=1, ?gallery, or window.__efreMock.lock("idle").`,
  );
  if (!new URLSearchParams(window.location.search).has("gallery")) return false;
  void import("./gallery").then(({ Gallery }) => {
    createRoot(root).render(
      <StrictMode>
        <Gallery />
      </StrictMode>,
    );
  });
  return true;
}
