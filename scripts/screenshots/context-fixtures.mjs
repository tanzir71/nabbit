import { clipboardFixture } from "./clipboard-fixtures.mjs";
import { imageDocumentFixture } from "./image-document-fixtures.mjs";
export const textTools = [
  ["upper", "UPPERCASE", "case"],
  ["lower", "lowercase", "case"],
  ["title", "Title Case", "case"],
  ["sentence", "Sentence case", "case"],
  ["kebab", "kebab-case", "case"],
  ["snake", "snake_case", "case"],
  ["trim", "Trim lines", "lines"],
  ["sort", "Sort lines", "lines"],
  ["dedupe", "Remove duplicate lines", "lines"],
  ["json", "Format JSON", "main"],
  ["base64-encode", "Encode Base64", "encoding"],
  ["base64-decode", "Decode Base64", "encoding"],
  ["url-encode", "Encode URL component", "encoding"],
  ["url-decode", "Decode URL component", "encoding"],
  ["count", "Count words", "main"],
].map(([id, name, group]) => ({ id, name, group }));
export function contextFixture(mode) {
  const seed = clipboardFixture("all");
  seed.data.settings.lastTab = "clipboard";
  const kinds = {
    link: "link",
    video: "video",
    json: "json",
    image: "image",
    files: "files",
    path: "path",
    "selected-link": "video",
  };
  const kind = kinds[mode] ?? "text";
  const content =
    {
      link: "https://example.invalid/article?utm_source=clipboard#read",
      video: "https://youtu.be/fixture",
      json: '{"name":"Nabbit","local":true,"items":[1,2,3]}',
      image: "Copied image 640 × 480",
      files: JSON.stringify(["C:\\Fixture\\one.png", "C:\\Fixture\\two.png"]),
      path: "C:\\Fixture\\Documents",
      "selected-link": "https://youtu.be/fixture",
    }[mode] ?? "Keep useful things close.\nOriginal text stays in history.";
  const entry = {
    ...seed.data.clipboard[0],
    id: "context-original",
    content,
    preview: kind === "files" ? "2 files · one.png" : content.split("\n")[0],
    contentType:
      kind === "image"
        ? "image"
        : ["path", "files"].includes(kind)
          ? "file"
          : ["link", "video"].includes(kind)
            ? "url"
            : "text",
    pinned: false,
    sourceApp: "Owned fixture",
  };
  seed.data.clipboard = [entry];
  const catalog = imageDocumentFixture("convert").responses.tool_catalog;
  const compatible = catalog.filter((t) =>
    (kind === "image"
      ? ["to-jpg", "image-text", "decode-qr"]
      : kind === "files"
        ? ["to-jpg", "images-pdf"]
        : []
    ).includes(t.id),
  );
  seed.responses.clipboard_context =
    mode === "blocked"
      ? null
      : {
          entry,
          kind,
          selection: ["selection", "selected-link"].includes(mode),
          tools: compatible,
          textTools,
        };
  if (mode === "error") seed.failures = { clipboard_context: "Fixture context is unavailable" };
  seed.responses.context_batch = { batch: null, error: null };
  return seed;
}
