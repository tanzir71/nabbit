import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IslandSpike } from "./IslandSpike";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const data = (url = "", text = "", files: string[] = []) => ({
  getData: (type: string) => (type === "text/uri-list" ? url : text),
  files: files.map((name) => ({ name })),
  types: files.length ? ["Files"] : [url ? "text/uri-list" : "text/plain"],
});

describe("island synthetic HTML5 drag events", () => {
  it.each([
    ["link", data("https://example.org/video"), "download"],
    ["files", data("", "", ["sample.mp4"]), "shelf"],
    ["text", data("", "A quick note"), "note"],
  ] as const)(
    "routes %s to the first matching zone and keeps it as a review candidate",
    (kind, transfer, zone) => {
      const { container } = render(<IslandSpike />);
      const frame = screen.getByRole("main");
      fireEvent.dragEnter(frame, { dataTransfer: transfer });
      expect(container.querySelector(".spike-pill")).toHaveAttribute("data-state", "drop");
      expect(container.querySelector(".drop-zone")).toHaveAttribute("data-drop-zone", zone);
      fireEvent.drop(container.querySelector(`[data-drop-zone="${zone}"]`)!, {
        dataTransfer: transfer,
      });
      expect(screen.getByRole("status")).toHaveTextContent(`Ready for review · ${kind} · ${zone}`);
      expect(container.querySelector(".spike-pill")).toHaveAttribute("data-state", "idle");
    },
  );
  it("rejects an executable URI and cancels when the drag leaves the band/target", () => {
    const { container } = render(<IslandSpike />);
    const frame = screen.getByRole("main");
    fireEvent.dragEnter(frame, { dataTransfer: data("javascript:alert(1)") });
    fireEvent.drop(frame, { dataTransfer: data("javascript:alert(1)") });
    expect(screen.getByRole("status")).toHaveTextContent("Can't use this here");
    fireEvent.dragEnter(frame, { dataTransfer: data("https://example.org/") });
    fireEvent.dragLeave(frame, { clientX: 700, clientY: 350 });
    expect(container.querySelector(".spike-pill")).toHaveAttribute("data-state", "idle");
  });
});
