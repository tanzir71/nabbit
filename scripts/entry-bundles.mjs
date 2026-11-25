import assert from "node:assert/strict";
export const islandGzipBudget = 120_000;
const forbidden = [
  /^spikes\//,
  /^src\/views\/(?:ClipboardList|SettingsPanel)(?:\.|\/)/,
  /^src\/surfaces\/(?:settings|sticky)\//,
  /^src\/preview\//,
  /^src\/store\/useAppStore\./,
  /^src\/lib\/ipc\./,
  /^src\/(?:.*\/)?(?:[Ee]ditor|[Nn]oteEditor)(?:\.|\/)/,
  /(?:^|\/)node_modules\/(?:fuse\.js|@tanstack\/react-virtual|react-window|react-virtualized)\//,
];
export function collectChunks(chunks, seeds, includeDynamic = false) {
  const found = new Set(),
    queue = [...seeds];
  while (queue.length) {
    const file = queue.pop();
    if (found.has(file)) continue;
    const chunk = chunks[file];
    assert(chunk, `Missing emitted JS chunk: ${file}`);
    found.add(file);
    queue.push(...chunk.imports, ...(includeDynamic ? chunk.dynamicImports : []));
  }
  return [...found].sort();
}
export function measureEntry(chunks, entryFile, preloads = []) {
  const initial = collectChunks(chunks, [entryFile, ...preloads]);
  const all = collectChunks(chunks, [entryFile, ...preloads], true);
  return {
    initial,
    deferred: all.filter((file) => !initial.includes(file)),
    all,
    initialGzipBytes: initial.reduce((sum, file) => sum + chunks[file].gzipBytes, 0),
    allReachableGzipBytes: all.reduce((sum, file) => sum + chunks[file].gzipBytes, 0),
    initialModules: [...new Set(initial.flatMap((file) => chunks[file].modules))].sort(),
  };
}
export function assertIslandBudget(report, limit = islandGzipBudget) {
  assert(
    report.initialGzipBytes <= limit,
    `Island initial JS is ${report.initialGzipBytes} gzip bytes; budget ${limit}`,
  );
  const blocked = report.initialModules.filter((id) =>
    forbidden.some((pattern) => pattern.test(id.replace(/^virtual:/, ""))),
  );
  assert.deepEqual(
    blocked,
    [],
    `Island initial JS imports heavy or surface-specific modules: ${blocked.join(", ")}`,
  );
}
