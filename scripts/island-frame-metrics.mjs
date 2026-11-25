import assert from "node:assert/strict";

// Chromium's frame events identify a compositor stream by renderer + layerTreeId,
// and dropped frames by frameSeqId. A quiet or missing stream is not a zero-drop pass.
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/trace/handlers/FramesHandler.ts
export function summarizeFrames(events, frameId, morphs, refreshHz) {
  assert(Number.isFinite(refreshHz) && refreshHz > 1, "A measured refresh rate is required");
  const frameBudgetUs = 1000000 / refreshHz;
  return morphs.map((morph) => {
    const start = events.find((event) => event.name === `${morph.id}:start`);
    const end = events.find((event) => event.name === `${morph.id}:end`);
    assert(start && end && end.ts > start.ts, `${morph.id}: missing/reversed trace markers`);
    const mappings = events.filter(
      (event) =>
        event.name === "SetLayerTreeId" &&
        event.args?.data?.frame === frameId &&
        event.pid === start.pid &&
        event.ts <= end.ts,
    );
    assert(mappings.length, `${morph.id}: the target frame has no compositor mapping`);
    const mapping = mappings.sort((a, b) => a.ts - b.ts).at(-1);
    const layerTreeId = mapping.args.data.layerTreeId;
    assert(Number.isFinite(layerTreeId), "Missing layerTreeId");
    // BeginFrame/DroppedFrame timestamps can be the scheduled beginning of the
    // refresh containing our mutation. Include that refresh and one final draw.
    const windowStart = start.ts - frameBudgetUs;
    const windowEnd = end.ts + frameBudgetUs;
    const stream = events.filter(
      (event) =>
        event.pid === start.pid &&
        event.args?.layerTreeId === layerTreeId &&
        event.ts >= windowStart &&
        event.ts <= windowEnd &&
        event.ph === "I",
    );
    const unique = (name) => [
      ...new Map(
        stream
          .filter((event) => event.name === name && Number.isFinite(event.args.frameSeqId))
          .map((event) => [event.args.frameSeqId, event]),
      ).values(),
    ];
    const begun = unique("BeginFrame");
    const drawn = unique("DrawFrame").sort((a, b) => a.ts - b.ts);
    const dropped = unique("DroppedFrame");
    assert(
      begun.length >= 2 && drawn.length >= 2,
      `${morph.id}: insufficient compositor frames; do not infer zero drops`,
    );
    const gaps = drawn.slice(1).map((event, index) => (event.ts - drawn[index].ts) / 1000);
    return {
      ...morph,
      rendererPid: start.pid,
      layerTreeId,
      traceStartUs: start.ts,
      traceEndUs: end.ts,
      tracedDurationMs: (end.ts - start.ts) / 1000,
      accountingWindowUs: [windowStart, windowEnd],
      frameBudgetMs: frameBudgetUs / 1000,
      begunFrames: begun.length,
      drawnFrames: drawn.length,
      droppedFrames: dropped.length,
      partialFrames: dropped.filter((event) => event.args.hasPartialUpdate).length,
      droppedFrameSequenceIds: dropped.map((event) => event.args.frameSeqId),
      maxDrawGapMs: Math.max(0, ...gaps),
      withinTwoDroppedFrames: dropped.length <= 2,
    };
  });
}

export function selectFrameEvidence(events, frameId, results) {
  const streams = new Set(results.map((result) => `${result.rendererPid}/${result.layerTreeId}`));
  const renderers = new Set(results.map((result) => result.rendererPid));
  const mappings = new Map();
  return [...events]
    .sort((a, b) => a.ts - b.ts)
    .filter((event) => {
      if (event.name.startsWith("nabbit:motion:")) return true;
      if (
        event.name === "SetLayerTreeId" &&
        event.args?.data?.frame === frameId &&
        renderers.has(event.pid)
      ) {
        const previous = mappings.get(event.pid);
        mappings.set(event.pid, event.args.data.layerTreeId);
        return previous !== event.args.data.layerTreeId;
      }
      return (
        ["BeginFrame", "DrawFrame", "DroppedFrame"].includes(event.name) &&
        streams.has(`${event.pid}/${event.args?.layerTreeId}`)
      );
    });
}
