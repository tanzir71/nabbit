import { describe, expect, it } from "vitest";
import { classify, readDrag, routeDrop, zoneOrder } from "./drop";

describe("island drop routing", () => {
  it("prioritises download, shelf and note for URLs, files and text", () => {
    expect(zoneOrder(classify({ url: "https://example.org/video" }))[0]).toBe("download");
    expect(zoneOrder(classify({ files: ["movie.mp4"] }))[0]).toBe("shelf");
    expect(zoneOrder(classify({ text: "A note from another app" }))[0]).toBe("note");
    expect(routeDrop({ text: "https://example.org/" }).zone).toBe("download");
  });
  it("keeps explicit zones, permits link notes and rejects incompatible data", () => {
    expect(routeDrop({ url: "https://example.org/" }, "note").message).toBe("Ready for review");
    expect(routeDrop({ files: ["image.png"] }, "note").message).toBe("Ready for review");
    expect(routeDrop({ files: ["movie.mp4"] }, "download").message).toBe("Can't use this here");
    expect(routeDrop({ url: "javascript:alert(1)" }).message).toBe("Can't use this here");
    expect(routeDrop({}).kind).toBe("unsupported");
  });
  it("reads synthetic DataTransfer without opening files or executing links", () => {
    const data = {
      getData: (type: string) =>
        type === "text/uri-list" ? "# comment\r\nhttps://example.org/film" : "Caption",
      files: [{ name: "clip.mp4" }],
      types: ["text/uri-list", "Files"],
    } as unknown as DataTransfer;
    expect(readDrag(data)).toEqual({
      url: "https://example.org/film",
      text: "Caption",
      files: ["clip.mp4"],
      types: ["text/uri-list", "Files"],
    });
    expect(classify({ types: ["Files"] }, true)).toBe("files");
    expect(classify({ types: ["text/uri-list"] }, true)).toBe("link");
  });
});
