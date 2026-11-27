import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    maxWorkers: 2,
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    exclude: [...configDefaults.exclude, "src-tauri/target/**", ".tools/**", "progress/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
