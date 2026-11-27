import { powerFixture } from "./power-fixtures.mjs";
export const toolCatalog = [
  {
    id: "to-mp4",
    name: "To MP4",
    category: "media",
    icon: "iconFile",
    keywords: ["video", "convert", "mov", "mkv", "h264"],
    accepts: {
      filetypes: ["mp4", "mov", "mkv", "webm", "avi", "m4v"],
      text: false,
      link: false,
      image: false,
    },
    presets: ["mp4"],
    form: [],
  },
  {
    id: "to-jpg",
    name: "To JPG",
    category: "images",
    icon: "iconImage",
    keywords: ["image", "photo", "convert", "jpeg", "png", "webp"],
    accepts: { filetypes: ["png", "jpg", "jpeg", "webp"], text: false, link: false, image: true },
    presets: ["jpg"],
    form: [{ key: "quality", label: "Quality", min: 1, max: 100, default: 85, advanced: true }],
  },
];
export const toolPresets = [
  { id: "mp4", name: "To MP4", maxMb: null, quality: 85 },
  { id: "jpg", name: "To JPG", maxMb: null, quality: 85 },
];
export function toolsFixture(mode) {
  const seed = powerFixture("idle"),
    snapshot = seed.responses.get_activity_snapshot,
    view = snapshot.views[0];
  const event = mode.startsWith("result")
    ? {
        kind: "toolResult",
        jobId: "result",
        path: "C:\\Fixture\\clip.mp4",
        beforeBytes: 42000000,
        afterBytes: 19600000,
        note: "Fits Discord",
      }
    : {
        kind: "toolJob",
        jobId: "tool",
        toolId: "to-mp4",
        label: "To MP4",
        percent: 64,
        state: mode === "failed-peek" ? "failed" : "running",
      };
  const state = mode.endsWith("compact") ? "live" : mode.endsWith("peek") ? "peek" : "expanded";
  view.primary =
    state === "expanded"
      ? null
      : {
          id: mode.startsWith("result") ? "toolResult:result" : "tool:tool",
          category: mode.startsWith("result") ? "result" : "tool",
          alert: mode.startsWith("result"),
          bubbleOnly: false,
          event,
        };
  Object.assign(seed.responses.get_island_surface, {
    state,
    width: mode.startsWith("result") ? 340 : 300,
    height: 32,
    snapshot,
  });
  seed.responses.tool_catalog = toolCatalog;
  seed.responses.tool_presets = toolPresets;
  seed.responses.list_island_pins = [
    { id: "pin", kind: "folder", path: "D:\\Docs\\PDFs", label: "PDF invoices", slot: 1 },
  ];
  seed.data.shelf = [
    {
      id: "shelf",
      path: "C:\\Fixture\\contract-v3.pdf",
      name: "contract-v3.pdf",
      kind: "file",
      size: 1200000,
      available: true,
    },
  ];
  const card = (id, title, kind = "note", url = "") => ({
    localOnly: true,
    scope: null,
    value: {
      id,
      title,
      kind,
      url,
      body: "PDF invoices",
      ref: "",
      priority: "now",
      labels: ["admin"],
      items: [],
      archived: false,
      trashedAt: null,
      rank: id,
      color: "default",
    },
  });
  seed.data.notes = [
    card("41", "Invoice PDFs for November"),
    card("42", "PDF reference", "bookmark", "https://example.test/pdf"),
  ];
  seed.data.clipboard = [
    {
      id: "clip",
      content: "D:\\Docs\\invoice-118.pdf",
      preview: "D:\\Docs\\invoice-118.pdf",
      contentType: "text",
      createdAt: "2026-11-28T08:00:00Z",
      sourceApp: "Fixture",
    },
  ];
  seed.responses.tool_jobs = [
    {
      id: "result",
      request: { toolId: "to-mp4", input: "C:\\Fixture\\clip.mov", presetId: "mp4" },
      preset: toolPresets[0],
      status: mode === "queue-cancelled" ? "cancelled" : "completed",
      percent: 100,
      createdAt: "2026-11-28T08:00:00Z",
      output: mode === "queue-cancelled" ? null : "C:\\Fixture\\clip (To MP4).mp4",
      beforeBytes: 42000000,
      afterBytes: 19600000,
      note: "To MP4",
      error: null,
    },
  ];
  return seed;
}
