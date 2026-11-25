import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { generateIslandMotion } from "./generate-island-motion.mjs";
import "./generate-tokens.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await generateIslandMotion();
for (const args of [
  ["node_modules/typescript/bin/tsc", "-b"],
  ["node_modules/vite/bin/vite.js", "build"],
  ["scripts/verify-entry-bundles.mjs"],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    windowsHide: true,
    stdio: "inherit",
    env: { ...process.env, NABBIT_ISLAND_SPIKE: "1" },
  });
  assert.equal(result.status, 0, `Spike build failed: ${args[0]}`);
}
