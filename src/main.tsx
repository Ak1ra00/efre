import "@fontsource-variable/inter";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";

async function start() {
  const root = document.getElementById("root");
  if (!root) throw new Error("efre: #root element missing");

  // `npm run dev:mock` only: an in-browser stand-in for Rust (src/dev). In every other
  // mode this branch is a constant `false` and the bundler drops it, so the mock never
  // ships; the build fails if it ever does (vite.config.ts, src/dev/mock-exclusion.test.ts).
  if (import.meta.env.MODE === "mock") {
    const { startMockPreview } = await import("./dev/mock-entry");
    if (startMockPreview(root)) return;
  }

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
