import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const files = ["docs/index.html", "docs/demo/index.html", "docs/llms.txt", "docs/.nojekyll"];
for (const file of files) await access(resolve(file));

const landing = await readFile("docs/index.html", "utf8");
const demo = await readFile("docs/demo/index.html", "utf8");
const checks = [
  landing.includes('property="og:title"'),
  landing.includes('data-copy="agent"'),
  landing.includes('href="demo/"'),
  demo.includes("Simulated demo"),
  demo.includes("does not read your clipboard"),
  demo.includes('id="download"'),
];
if (checks.some((check) => !check)) throw new Error("Nabbit site contract failed");
globalThis.console.log(`Verified Nabbit site: ${String(checks.length)} contracts.`);
