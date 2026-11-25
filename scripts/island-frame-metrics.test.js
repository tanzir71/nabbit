import { describe, expect, it } from "vitest";
import { summarizeFrames } from "./island-frame-metrics.mjs";

const frame = (name, ts, id, extra = {}) => ({
  name,
  ts,
  ph: "I",
  pid: 100,
  tid: 10,
  args: { layerTreeId: 7, frameSeqId: id, ...extra },
});
const fixture = () => [
  { name: "SetLayerTreeId", ts: 0, pid: 100, args: { data: { frame: "target", layerTreeId: 7 } } },
  { name: "morph:start", ts: 100000, pid: 100 },
  frame("BeginFrame", 100000, 1),
  frame("DrawFrame", 101000, 1),
  frame("BeginFrame", 116667, 2),
  frame("DrawFrame", 117000, 2),
  { name: "morph:end", ts: 130000, pid: 100 },
];
const summarize = (events) =>
  summarizeFrames(events, "target", [{ id: "morph", from: "idle", to: "live" }], 60)[0];
describe("compositor measurement accounting", () => {
  it("counts unique explicit dropped frames, including partial updates", () => {
    const dropped = frame("DroppedFrame", 120000, 3, { hasPartialUpdate: true });
    const result = summarize([...fixture(), dropped, dropped]);
    expect(result.droppedFrames).toBe(1);
    expect(result.partialFrames).toBe(1);
    expect(result.drawnFrames).toBe(2);
  });
  it("does not mix another renderer, layer tree or measurement window", () => {
    const dropped = frame("DroppedFrame", 120000, 3);
    expect(
      summarize([
        ...fixture(),
        { ...dropped, pid: 200 },
        { ...dropped, args: { ...dropped.args, layerTreeId: 8 } },
        { ...dropped, ts: 500000 },
      ]).droppedFrames,
    ).toBe(0);
  });
  it("rejects missing compositor data instead of passing zero drops", () => {
    expect(() => summarize(fixture().filter((event) => event.name !== "DrawFrame"))).toThrow(
      /insufficient/,
    );
    expect(() => summarize(fixture().filter((event) => event.name !== "SetLayerTreeId"))).toThrow(
      /mapping/,
    );
  });
  it("uses the measured refresh and includes the refresh containing the mutation", () => {
    const result = summarize([...fixture(), frame("DroppedFrame", 90000, 0)]);
    expect(result.droppedFrames).toBe(1);
    expect(result.frameBudgetMs).toBeCloseTo(1000 / 60);
    expect(() => summarizeFrames(fixture(), "target", [{ id: "morph" }], 0)).toThrow(/refresh/);
  });
  it("retains a failing measurement rather than hiding it or changing the limit", () => {
    const result = summarize([
      ...fixture(),
      ...[3, 4, 5].map((id) => frame("DroppedFrame", 120000 + id, id)),
    ]);
    expect(result.droppedFrames).toBe(3);
    expect(result.withinTwoDroppedFrames).toBe(false);
  });
  it("rejects missing/end-before-start trace markers", () => {
    expect(() => summarize(fixture().filter((event) => event.name !== "morph:end"))).toThrow(
      /markers/,
    );
    expect(() =>
      summarize(
        fixture().map((event) => (event.name === "morph:end" ? { ...event, ts: 1 } : event)),
      ),
    ).toThrow(/markers/);
  });
});
