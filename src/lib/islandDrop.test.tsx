import { useState } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../features/files/api", () => ({
  filesApi: { pins: async () => [], hints: async () => ({}) },
}));
vi.mock("../features/tools/api", () => ({ toolsApi: { catalog: async () => [] } }));
import { DropContent } from "../surfaces/island/DropContent";
import { classify, readDrag, routeDrop, type DropZone, type Receipt } from "./islandDrop";

function transfer(type: string, value: string) {
  return {
    types: [type],
    files: type === "Files" ? [new File(["fixture"], value)] : [],
    getData: (requested: string) => (requested === type ? value : ""),
  };
}

describe("island drop payload contract", () => {
  it.each([
    ["text/uri-list", "# source\r\nhttps://example.invalid/video", "download", "link"],
    ["Files", "receipt.pdf", "shelf", "files"],
    ["text/plain", "Keep this thought", "note", "text"],
  ] as const)(
    "routes a synthetic %s drop using its visible zone order",
    async (type, value, first, kind) => {
      const receipts: Receipt[] = [];
      function Target() {
        const [over, setOver] = useState<DropZone | null>(null);
        return (
          <div
            onDrop={(event) => {
              event.preventDefault();
              const payload = readDrag(event.dataTransfer);
              receipts.push(routeDrop(payload, over ?? undefined));
            }}
          >
            <DropContent payload={{ types: [type] }} over={over} setOver={setOver} />
          </div>
        );
      }
      const view = render(<Target />);
      await waitFor(() =>
        expect(view.container.querySelectorAll("[data-drop-zone]").length).toBeGreaterThan(0),
      );
      const zones = [...view.container.querySelectorAll<HTMLElement>("[data-drop-zone]")];
      expect(zones.map((zone) => zone.dataset.dropZone)).toEqual(
        first === "shelf"
          ? ["shelf", "move"]
          : first === "note"
            ? ["note", "download", "shelf"]
            : ["download", "shelf", "note"],
      );
      fireEvent.dragEnter(zones[0], { dataTransfer: transfer(type, value) });
      fireEvent.drop(zones[0], { dataTransfer: transfer(type, value) });
      expect(receipts).toEqual([{ kind, zone: first, count: 1, message: "Ready for review" }]);
      if (first === "shelf") {
        const move = zones.find((zone) => zone.dataset.dropZone === "move")!;
        fireEvent.dragOver(move, { dataTransfer: transfer(type, value) });
        fireEvent.drop(move, { dataTransfer: transfer(type, value) });
        expect(receipts[1]).toMatchObject({ zone: "move", message: "Ready for review" });
        expect(
          routeDrop(readDrag(transfer(type, value) as unknown as DataTransfer), "download").message,
        ).toBe("Can't use this here");
        return;
      }
      // An explicit zone is retained and can reject an otherwise supported payload.
      const rejected = zones.find((zone) => zone.dataset.dropZone === "shelf")!;
      fireEvent.dragOver(rejected, { dataTransfer: transfer(type, value) });
      fireEvent.drop(rejected, { dataTransfer: transfer(type, value) });
      expect(receipts[1].message).toBe("Can't use this here");
      expect(receipts[1].zone).toBe(rejected.dataset.dropZone);
    },
  );

  it("rejects non-web URI schemes and preserves image-only note intake", () => {
    expect(classify({ url: "javascript:alert(1)", text: "https://example.invalid" })).toBe(
      "unsupported",
    );
    expect(routeDrop({ url: "file:///private.txt" }).message).toBe("Can't use this here");
    expect(routeDrop({ files: ["one.PNG", "two.heic"] }, "note")).toMatchObject({
      count: 2,
      message: "Ready for review",
    });
    expect(routeDrop({ files: ["one.png", "two.pdf"] }, "note").message).toBe(
      "Can't use this here",
    );
  });
});
