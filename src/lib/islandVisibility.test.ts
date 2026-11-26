import { afterEach, expect, it, vi } from "vitest";
import {
  connectIslandVisibility,
  type IslandVisibility,
  type VisibilityTransport,
} from "./islandVisibility";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const report = (
  mode: IslandVisibility["mode"],
  revision: number,
  label = "island",
): IslandVisibility => ({
  label,
  mode,
  base: mode,
  reason: "none",
  opacity: mode === "hidden" ? 0 : mode === "faded" ? 0.35 : 1,
  revision,
});
function setup(
  snapshot: () => Promise<{ visibility?: IslandVisibility[] }> = async () => ({
    visibility: [report("visible", 0)],
  }),
) {
  const host = document.createElement("main");
  document.body.append(host);
  let receive!: (value: IslandVisibility) => void;
  const stop = vi.fn();
  const transport: VisibilityTransport = {
    subscribe: vi.fn(async (callback) => {
      receive = callback;
      return stop;
    }),
    snapshot,
  };
  const connection = connectIslandVisibility(host, { label: "island", transport });
  return { host, connection, stop, send: (value: IslandVisibility) => receive(value) };
}
it("applies native opacity and input gates without changing geometry or polling", async () => {
  const interval = vi.spyOn(window, "setInterval"),
    frames = vi.spyOn(window, "requestAnimationFrame");
  const { host, connection, send } = setup();
  host.style.width = "720px";
  host.style.height = "460px";
  await connection.ready;
  for (const [mode, opacity, pointer] of [
    ["faded", "0.35", "none"],
    ["hidden", "0", "none"],
    ["visible", "1", "auto"],
  ] as const) {
    send(report(mode, mode === "faded" ? 1 : mode === "hidden" ? 2 : 3));
    expect(host.dataset.islandVisibility).toBe(mode);
    expect(host.style.opacity).toBe(opacity);
    expect(host.style.pointerEvents).toBe(pointer);
    expect(host.getAttribute("aria-hidden")).toBe(String(mode === "hidden"));
    expect(host.style.width).toBe("720px");
    expect(host.style.height).toBe("460px");
    expect(host.style.display).toBe("");
    expect(host.style.visibility).toBe("");
  }
  expect(interval).not.toHaveBeenCalled();
  expect(frames).not.toHaveBeenCalled();
  connection.dispose();
});
it("subscribes before snapshot and rejects stale snapshots, stale events and another monitor", async () => {
  let resolve!: (value: { visibility: IslandVisibility[] }) => void;
  const { host, connection, send } = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await Promise.resolve();
  send(report("hidden", 4));
  resolve({ visibility: [report("visible", 1)] });
  await connection.ready;
  send(report("faded", 3));
  send(report("visible", 99, "island-left"));
  expect(host.style.opacity).toBe("0");
  connection.dispose();
  send(report("visible", 5));
  expect(host.style.opacity).toBe("0");
});
it("cleans up a subscription that resolves after teardown without reading or mutating", async () => {
  let resolve!: (value: () => void) => void;
  const stop = vi.fn(),
    snapshot = vi.fn();
  const transport: VisibilityTransport = {
    subscribe: () =>
      new Promise((done) => {
        resolve = done;
      }),
    snapshot,
  };
  const host = document.createElement("main"),
    connection = connectIslandVisibility(host, { label: "island", transport });
  connection.dispose();
  resolve(stop);
  await connection.ready;
  expect(stop).toHaveBeenCalledOnce();
  expect(snapshot).not.toHaveBeenCalled();
  expect(host.style.opacity).toBe("");
});
it("ignores a snapshot after teardown and reports transport failures", async () => {
  let resolve!: (value: { visibility: IslandVisibility[] }) => void;
  const { host, connection, stop } = setup(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await Promise.resolve();
  connection.dispose();
  resolve({ visibility: [report("hidden", 2)] });
  await connection.ready;
  expect(stop).toHaveBeenCalledOnce();
  expect(host.style.opacity).toBe("");
  const onError = vi.fn(),
    error = new Error("unavailable");
  await connectIslandVisibility(host, {
    label: "island",
    transport: { subscribe: () => Promise.reject(error), snapshot: vi.fn() },
    onError,
  }).ready;
  expect(onError).toHaveBeenCalledWith(error);
});
it("keeps an unbound surface transparent until its own native state arrives", async () => {
  const { host, connection, send } = setup(async () => ({
    visibility: [report("visible", 0, "island-left")],
  }));
  host.style.opacity = "0";
  await connection.ready;
  expect(host.style.opacity).toBe("0");
  const known = vi.fn();
  void connection.known.then(known);
  await Promise.resolve();
  expect(known).not.toHaveBeenCalled();
  send(report("faded", 1));
  await connection.known;
  expect(host.style.opacity).toBe("0.35");
  expect(host.style.getPropertyValue("--native-island-opacity")).toBe("0.35");
  connection.dispose();
});
