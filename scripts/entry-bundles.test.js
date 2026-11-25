import { describe, expect, it } from "vitest";
import { collectChunks, measureEntry, assertIslandBudget } from "./entry-bundles.mjs";
const chunk = (gzipBytes, imports = [], modules = [], dynamicImports = []) => ({
  gzipBytes,
  imports,
  modules,
  dynamicImports,
});
describe("island bundle boundary", () => {
  it("counts shared chunks once, follows cycles, and separates lazy bodies", () => {
    const chunks = {
      island: chunk(1000, ["react", "common"], ["src/surfaces/island/main.tsx"], ["settings"]),
      react: chunk(49000, ["common"], ["node_modules/react/index.js"]),
      common: chunk(1000, ["react"], ["src/store/islandStore.ts"]),
      settings: chunk(5000, [], ["src/views/SettingsPanel.tsx"]),
    };
    const report = measureEntry(chunks, "island");
    expect(report.initialGzipBytes).toBe(51000);
    expect(report.allReachableGzipBytes).toBe(56000);
    expect(report.deferred).toEqual(["settings"]);
    expect(() => assertIslandBudget(report)).not.toThrow();
  });
  it("counts an HTML preload even when no module imports it", () => {
    const report = measureEntry({ island: chunk(1000), preloaded: chunk(120000) }, "island", [
      "preloaded",
    ]);
    expect(() => assertIslandBudget(report)).toThrow(/budget/);
  });
  it("rejects a heavy UI module hidden inside a shared initial chunk", () => {
    const report = measureEntry(
      {
        island: chunk(1000, ["shared"]),
        shared: chunk(1000, [], ["virtual:src/views/ClipboardList.tsx?commonjs-proxy"]),
      },
      "island",
    );
    expect(() => assertIslandBudget(report)).toThrow(/ClipboardList/);
  });
  it("fails closed on missing chunks and enforces the exact budget boundary", () => {
    expect(() => collectChunks({ island: chunk(1000, ["missing"]) }, ["island"])).toThrow(
      /Missing/,
    );
    expect(() =>
      assertIslandBudget(measureEntry({ island: chunk(120000) }, "island")),
    ).not.toThrow();
    expect(() => assertIslandBudget(measureEntry({ island: chunk(120001) }, "island"))).toThrow(
      /120001/,
    );
  });
});
