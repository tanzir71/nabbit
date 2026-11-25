import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import "./generate-tokens.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const args of [
  ["node_modules/typescript/bin/tsc", "-b"],
  ["node_modules/vite/bin/vite.js", "build"],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    windowsHide: true,
    stdio: "inherit",
    env: { ...process.env, NABBIT_COMPONENT_PREVIEW: "1" },
  });
  assert.equal(result.status, 0, `Components build failed: ${args[0]}`);
}
