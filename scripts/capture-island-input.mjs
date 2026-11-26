import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./screenshots/harness.mjs";
import { scenarios } from "./screenshots/scenarios.mjs";
const report = await captureSuite(
  fileURLToPath(new URL("../", import.meta.url)),
  { milestone: "M4", prefix: "v22", suite: "surfaces" },
  scenarios.filter((scenario) => scenario.name === "island-idle"),
);
globalThis.console.log(
  `Captured ${report.captures.length} input-enabled idle PNGs with mocked IPC.`,
);
