// @vitest-environment node
/**
 * The dev mock backend must never ship. `npm run build` (production mode) is built here
 * in memory with the real vite.config.ts and scanned for the mock's marker string and
 * for any module from src/dev or src/test. A mock-mode build is the positive control:
 * it must contain the marker, or this scan would prove nothing.
 *
 * (vite.config.ts additionally fails every production build that contains the marker.)
 */
import { build } from "vite";
import { describe, expect, it } from "vitest";

// Same string as MOCK_MARKER in mock-backend.ts (not imported, so it can't be renamed away).
const MARKER = "efre-dev-mock-backend";

interface Scan {
  files: string[];
  withMarker: string[];
  devModules: string[];
}

async function buildInMemory(mode: "production" | "mock"): Promise<Scan> {
  const result = await build({
    configFile: "vite.config.ts",
    mode,
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const scan: Scan = { files: [], withMarker: [], devModules: [] };
  for (const output of outputs) {
    if (!("output" in output)) throw new Error("unexpected watcher from build()");
    for (const file of output.output) {
      scan.files.push(file.fileName);
      const text =
        file.type === "chunk"
          ? file.code
          : typeof file.source === "string"
            ? file.source
            : new TextDecoder().decode(file.source);
      if (text.includes(MARKER)) scan.withMarker.push(file.fileName);
      if (file.type === "chunk") {
        scan.devModules.push(...file.moduleIds.filter((id) => /[\\/]src[\\/](dev|test)[\\/]/.test(id)));
      }
    }
  }
  return scan;
}

describe("dev mock exclusion", () => {
  it("the production build contains no mock code", async () => {
    const scan = await buildInMemory("production");
    expect(scan.files.some((f) => f.endsWith(".js"))).toBe(true);
    expect(scan.withMarker).toEqual([]);
    expect(scan.devModules).toEqual([]);
    expect(scan.files.filter((f) => /mock|gallery/i.test(f))).toEqual([]);
  }, 60_000);

  it("a mock-mode build does contain it (positive control)", async () => {
    const scan = await buildInMemory("mock");
    expect(scan.withMarker.length).toBeGreaterThan(0);
    expect(scan.devModules.length).toBeGreaterThan(0);
  }, 60_000);
});
