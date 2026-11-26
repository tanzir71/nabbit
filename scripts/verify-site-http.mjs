import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { preview } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: { assets: { type: "string" }, report: { type: "string" } },
});
assert(
  values.assets && values.report,
  "Pass --assets <fresh static report> --report <unused output>",
);
const audit = JSON.parse(await readFile(resolve(root, values.assets), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paths = [
  ...new Set([
    ...audit.files.map((entry) => entry.file),
    "og.html",
    "assets/og.png",
    "assets/og-manifest.json",
  ]),
];
let server;
try {
  server = await preview({
    build: { outDir: "docs" },
    base: "/nabbit/",
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
    logLevel: "error",
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const files = await Promise.all(
    paths.map(async (file) => {
      assert(!file.includes("..") && !/^(?:\/|[a-z]+:)/i.test(file));
      const response = await globalThis.fetch(`${origin}/nabbit/${file}`);
      assert.equal(response.status, 200, file);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const source = await readFile(resolve(root, "docs", file));
      assert.equal(sha(bytes), sha(source), `Wrong HTTP body under /nabbit/: ${file}`);
      const previous = audit.files.find((entry) => entry.file === file);
      if (previous) assert.equal(sha(source), previous.sha256, `Stale static audit: ${file}`);
      return { file, status: response.status, bytes: bytes.length, sha256: sha(bytes) };
    }),
  );
  assert(audit.transferBytesExcludingFonts <= 500000);
  await writeFile(
    resolve(root, values.report),
    JSON.stringify(
      {
        basePath: "/nabbit/",
        files,
        transferBytesExcludingFonts: audit.transferBytesExcludingFonts,
        thirdPartyResources: [],
        result: "Every resource resolves to the exact source bytes over local HTTP",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  globalThis.console.log(
    `Verified ${files.length} exact HTTP resource bodies under /nabbit/; ${audit.transferBytesExcludingFonts} bytes excluding fonts.`,
  );
} finally {
  if (server) await new Promise((done) => server.httpServer.close(done));
}
