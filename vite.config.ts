import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";
import { relative, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";

const modulePath = (id: string) => {
  const virtual = id.startsWith("\0");
  const file = virtual ? id.slice(1) : id;
  const normalized = /^(?:[a-zA-Z]:[\\/]|\/)/.test(file) ? relative(process.cwd(), file) : file;
  return `${virtual ? "virtual:" : ""}${normalized.replace(/\\/g, "/")}`;
};

// Keep source-module attribution outside dist. The verifier checks these hashes
// against emitted JS, so stale build metadata cannot approve a newer bundle.
const entryGraph: Plugin = {
  name: "nabbit-entry-graph",
  apply: "build",
  writeBundle(options, bundle) {
    const chunks = Object.fromEntries(
      Object.values(bundle)
        .filter((item) => item.type === "chunk")
        .map((chunk) => [
          chunk.fileName,
          {
            imports: chunk.imports,
            dynamicImports: chunk.dynamicImports,
            modules: Object.keys(chunk.modules).map(modulePath),
            sha256: createHash("sha256")
              .update(readFileSync(resolve(options.dir ?? "dist", chunk.fileName)))
              .digest("hex"),
          },
        ]),
    );
    mkdirSync(resolve("node_modules/.tmp"), { recursive: true });
    writeFileSync(
      resolve("node_modules/.tmp/nabbit-entry-graph.json"),
      JSON.stringify({ version: 1, chunks }, null, 2),
    );
  },
};

export default defineConfig({
  plugins: [react(), entryGraph],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    exclude: [...configDefaults.exclude, ".tools/**", "progress/**"],
  },
  clearScreen: false,
  build: {
    manifest: true,
    rollupOptions: {
      input: {
        main: resolve("index.html"),
        island: resolve("island.html"),
        settings: resolve("settings.html"),
        sticky: resolve("sticky.html"),
        ...(process.env.NABBIT_COMPONENT_PREVIEW === "1"
          ? { components: resolve("components.html") }
          : {}),
        ...(process.env.NABBIT_ISLAND_SPIKE === "1"
          ? { spike: resolve("spikes/island/index.html") }
          : {}),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
