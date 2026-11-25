import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import process from "node:process";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
  clearScreen: false,
  build: {
    rollupOptions: {
      input:
        process.env.NABBIT_ISLAND_SPIKE === "1"
          ? { main: resolve("index.html"), spike: resolve("spikes/island/index.html") }
          : resolve("index.html"),
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
