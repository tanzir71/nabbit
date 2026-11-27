import { powerFixture } from "./power-fixtures.mjs";
import { shelfPreview } from "./shelf-fixtures.mjs";
import { toolCatalog, toolPresets } from "./tools-fixtures.mjs";
export function filesFixture(mode) {
  const seed = powerFixture("idle"),
    snapshot = seed.responses.get_activity_snapshot,
    view = snapshot.views[0];
  const pins = [
    ["Invoices", "D:\\Docs\\Invoices", "folder"],
    ["Acme · client work", "D:\\Work\\Acme", "folder"],
    ["Screenshots", "D:\\Pictures\\Screenshots", "folder"],
    ["NAS · Archive", "\\\\nas\\archive", "folder"],
    ["Timesheet 2026.xlsx", "D:\\Work\\Timesheet 2026.xlsx", "file"],
    ["Contract template.docx", "D:\\Work\\Contract template.docx", "file"],
    ["Brand kit.pdf", "D:\\Work\\Brand kit.pdf", "file"],
    ["deploy-site.ps1", "D:\\Work\\deploy-site.ps1", "file"],
  ].map(([label, path, kind], index) => ({
    id: `pin-${index + 1}`,
    kind,
    path,
    label,
    slot: index + 1,
    alwaysMove: false,
    available: mode !== "pin-missing" || index !== 6,
    network: index === 3,
    cloud: index === 2,
  }));
  if (mode === "pin-search")
    pins.push({
      id: "pin-9",
      kind: "folder",
      path: "D:\\Archive\\Reports",
      label: "Archive reports",
      slot: 9,
      alwaysMove: false,
      available: true,
      network: false,
      cloud: false,
    });
  seed.responses.files_pins = pins;
  seed.responses.list_island_pins = pins;
  seed.responses.files_capabilities = {
    folders: [
      ["Desktop", "C:\\Users\\Fixture\\Desktop"],
      ["Downloads", "C:\\Users\\Fixture\\Downloads"],
      ["Documents", "D:\\Docs"],
    ],
    terminal: true,
    code: true,
  };
  const now = Date.parse("2026-11-26T09:00:00Z");
  seed.responses.files_peek_open = {
    token: "owned-fixture-peek",
    path: pins[0].path,
    watching: true,
    items: [
      ["invoice-118.pdf", 2 / 24],
      ["invoice-117.pdf", 1.1],
      ["receipt-scan.png", 3],
      ["INV-2026 tracker.xlsx", 3],
      ["invoice-116.pdf", 14],
      ["2025", 16],
    ].map(([name, days]) => ({
      name,
      path: pins[0].path + "\\" + name,
      directory: name === "2025",
      modified: (now - days * 86400000) * 1e6,
      cloud: false,
    })),
  };
  seed.responses.files_suggestions = ["D:\\Docs\\Courses", "D:\\Docs\\Invoices", "D:\\Archive"];
  seed.responses.files_hints = Object.fromEntries(
    pins
      .filter((p) => p.kind === "folder")
      .map((p) => [
        p.id,
        mode === "drop-copy" ? "Copy here" : p.network ? "Copy · other drive" : "Move here",
      ]),
  );
  seed.responses.files_history = [];
  seed.responses.tool_catalog = toolCatalog;
  seed.responses.tool_presets = toolPresets;
  seed.responses.tool_jobs = [];
  seed.responses.files_plan = {
    id: "owned-fixture-plan",
    destination: { path: "\\\\nas\\archive" },
    entries: [
      {
        source: { path: "C:\\Fixture\\hero-mock@2x.png" },
        verb: "copy",
        output: null,
        undone: false,
      },
    ],
    reasons: ["The destination is on a network."],
    bytes: 2400000,
    status: "prepared",
    error: null,
  };
  seed.data.shelf = [
    {
      id: "hero",
      name: "hero-mock@2x.png",
      path: "C:\\Fixture\\hero-mock@2x.png",
      kind: "image",
      size: 2400000,
      available: true,
    },
    {
      id: "video",
      name: "demo-island.mp4",
      path: "C:\\Fixture\\demo-island.mp4",
      kind: "video",
      size: 18100000,
      available: true,
    },
    {
      id: "document",
      name: "NABBIT_V2_HANDOFF.md",
      path: "C:\\Fixture\\NABBIT_V2_HANDOFF.md",
      kind: "file",
      size: 52000,
      available: true,
    },
  ];
  seed.shelfPreview = shelfPreview;
  const compact = mode === "moved-compact",
    peek = mode === "moved-peek" || mode === "download-done";
  const downloadPath = "C:\\Users\\Fixture\\Downloads\\Lecture 12 · Distributed systems.mkv";
  const event =
    mode === "download-done"
      ? { kind: "downloadDone", jobId: "owned-download", path: downloadPath }
      : {
          kind: "filesMoved",
          opId: "owned-operation",
          count: 3,
          destination: "D:\\Docs\\Invoices",
          verb: "moved",
          undoable: true,
        };
  seed.responses.files_download_info = {
    path: downloadPath,
    bytes: 1400000000,
    site: "example.invalid",
  };
  view.primary =
    compact || peek
      ? {
          id: mode === "download-done" ? "download:owned-download" : "files:owned-operation",
          category: "result",
          alert: true,
          bubbleOnly: false,
          event,
        }
      : null;
  Object.assign(seed.responses.get_island_surface, {
    state: compact ? "live" : peek ? "peek" : "expanded",
    width: compact ? 312 : peek ? 400 : 680,
    height: compact ? 32 : peek ? 120 : 420,
    snapshot,
    reducedMotion: false,
  });
  return seed;
}
