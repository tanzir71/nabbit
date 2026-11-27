import { fixtureData } from "./fixtures.mjs";
export const clipboardSnapshot = {
  revision: 1,
  views: [
    {
      label: "island",
      gate: "visible",
      primary: null,
      bubble: null,
      queue: [],
      fullscreen: false,
      userHidden: false,
      focusMode: false,
    },
  ],
  preferences: {
    order: [],
    disabled: [],
    showAlertsOverFullscreen: false,
    focusMode: false,
    hiddenUntilMs: null,
  },
  syncState: "localOnly",
};
export function clipboardFixture(mode = "all") {
  const data = fixtureData("tray-clipboard");
  data.clipboard = [
    ["text", "Meeting moved to 4:30", "Fixture editor", true],
    ["url", "https://example.invalid/research?utm_source=keep#section", "Fixture browser", false],
    ["image", "Screenshot 1280 × 720", "Image preview unavailable", false],
    ["file", "C:\\Fixture\\README.md", "Fixture Explorer", false],
  ].map(([contentType, content, sourceApp, pinned], i) => ({
    id: `clipboard-${i}`,
    contentType,
    content,
    preview: content,
    sourceApp,
    pinned,
    hash: `fixture-${i}`,
    createdAt: "2026-11-26T08:55:00Z",
    lastUsedAt: "2026-11-26T08:55:00Z",
  }));
  if (mode === "context") data.clipboard[1].lastUsedAt = "2026-11-26T08:59:00Z";
  if (mode === "scroll")
    data.clipboard.push(
      ...Array.from({ length: 80 }, (_, i) => ({
        ...data.clipboard[0],
        id: `extra-${i}`,
        content: `Fixture history ${i + 1}`,
        preview: `Fixture history ${i + 1}`,
        pinned: false,
      })),
    );
  if (mode === "empty") data.clipboard = [];
  return {
    data,
    responses: {
      get_activity_snapshot: clipboardSnapshot,
      get_island_surface: {
        label: "island",
        generation: 1,
        state: "expanded",
        owner: "webview",
        shape: "island",
        reducedMotion: true,
        width: 680,
        height: 336,
        snapshot: clipboardSnapshot,
        keyboard: { id: 1, target: "tab" },
      },
      get_island_drop: null,
      list_island_pins: [],
    },
    failures:
      mode === "error" ? { list_clipboard_entries: "Fixture history unavailable" } : undefined,
  };
}
