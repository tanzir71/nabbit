import { fixtureData } from "./fixtures.mjs";
import { clipboardSnapshot } from "./clipboard-fixtures.mjs";
export const shelfPreview =
  "data:image/png;base64,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";
export function shelfFixture(mode = "files") {
  const data = fixtureData("tray-downloads");
  data.shelf = [
    {
      id: "photo",
      path: "C:\\Fixture\\hero-mock@2x.png",
      name: "hero-mock@2x.png",
      kind: "image",
      size: 2400000,
      available: true,
    },
    {
      id: "video",
      path: "C:\\Fixture\\demo-island.mp4",
      name: "demo-island.mp4",
      kind: "video",
      size: 18100000,
      available: true,
    },
    {
      id: "file",
      path: "C:\\Fixture\\NABBIT_V2_HANDOFF.md",
      name: "NABBIT_V2_HANDOFF.md",
      kind: "file",
      size: 52000,
      available: true,
    },
  ];
  if (mode === "selected")
    data.shelf = [
      { ...data.shelf[0], id: "heic-1", name: "IMG_4821.HEIC", size: 1200000 },
      { ...data.shelf[0], id: "heic-2", name: "IMG_4822.HEIC", size: 380000 },
      { ...data.shelf[0], id: "receipt", name: "receipt-scan.png", size: 2100000 },
      data.shelf[1],
    ];
  if (mode === "missing") data.shelf[2] = { ...data.shelf[2], available: false, size: null };
  if (mode === "empty") data.shelf = [];
  if (mode === "many")
    data.shelf.push(
      ...Array.from({ length: 36 }, (_, i) => ({
        ...data.shelf[2],
        id: `extra-${i}`,
        name: `Fixture document ${i + 1}.md`,
        path: `C:\\Fixture\\document-${i}.md`,
      })),
    );
  return {
    data,
    shelfPreview: ["no-preview", "selected"].includes(mode) ? null : shelfPreview,
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
    failures: mode === "error" ? { shelf_list: "Owned fixture failure" } : undefined,
  };
}
