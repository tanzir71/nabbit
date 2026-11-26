import { parseArgs } from "node:util";
import { fileURLToPath, URL } from "node:url";
import { captureSuite } from "./harness.mjs";

const { values } = parseArgs({
  options: {
    milestone: { type: "string" },
    prefix: { type: "string" },
    suite: { type: "string", default: "all" },
    "repeat-check": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  globalThis.console.log(
    "npm run screenshots -- --milestone M2 --prefix v16 [--suite all|surfaces|foundations] [--repeat-check]\nCreates light/dark × 1/1.5 device-scale PNGs under progress/v2/M<n>/. Existing output is never overwritten.",
  );
} else {
  const report = await captureSuite(fileURLToPath(new URL("../../", import.meta.url)), {
    milestone: values.milestone,
    prefix: values.prefix,
    suite: values.suite,
    repeatCheck: values["repeat-check"],
  });
  globalThis.console.log(
    `Captured ${report.captures.length} verified PNGs with mocked IPC in progress/v2/${report.milestone}/ (${report.prefix}).`,
  );
}
