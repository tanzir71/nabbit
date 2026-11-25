export type DropZone = "download" | "shelf" | "note";
export type PayloadKind = "link" | "files" | "text" | "unsupported";
export interface Payload {
  url?: string;
  text?: string;
  files?: string[];
  types?: readonly string[];
}
export interface Receipt {
  kind: PayloadKind;
  zone: DropZone;
  count: number;
  message: string;
}

export function classify(payload: Payload, hover = false): PayloadKind {
  if (payload.url) {
    try {
      if (["http:", "https:"].includes(new URL(payload.url).protocol)) return "link";
    } catch {
      /* Not a usable URL. */
    }
    return "unsupported";
  }
  if (payload.files?.length || (hover && payload.types?.includes("Files"))) return "files";
  if (payload.text?.trim()) {
    try {
      if (["http:", "https:"].includes(new URL(payload.text.trim()).protocol)) return "link";
    } catch {
      /* Plain text. */
    }
    return "text";
  }
  if (hover && payload.types?.includes("text/uri-list")) return "link";
  if (hover && payload.types?.includes("text/plain")) return "text";
  return "unsupported";
}
export function zoneOrder(kind: PayloadKind): DropZone[] {
  return kind === "files"
    ? ["shelf", "download", "note"]
    : kind === "text"
      ? ["note", "download", "shelf"]
      : ["download", "shelf", "note"];
}
export function routeDrop(payload: Payload, requested?: DropZone): Receipt {
  const kind = classify(payload);
  const zone = requested ?? zoneOrder(kind)[0];
  const imageFiles =
    kind === "files" && payload.files?.every((path) => /\.(png|jpe?g|gif|webp|heic)$/i.test(path));
  const accepted =
    zone === "download"
      ? kind === "link"
      : zone === "shelf"
        ? kind === "files"
        : kind === "link" || kind === "text" || imageFiles;
  return {
    kind,
    zone,
    count: payload.files?.length || (kind === "unsupported" ? 0 : 1),
    message: accepted ? "Ready for review" : "Can't use this here",
  };
}
export function readDrag(data: DataTransfer): Payload {
  return {
    url: data
      .getData("text/uri-list")
      .split(/\r?\n/)
      .find((line) => line.trim() && !line.startsWith("#")),
    text: data.getData("text/plain"),
    files: Array.from(data.files, (file) => file.name),
    types: Array.from(data.types),
  };
}
