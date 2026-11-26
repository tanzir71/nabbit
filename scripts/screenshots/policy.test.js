import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { outputOptions, pngInfo, pngBudget } from "./policy.mjs";

describe("screenshot evidence policy", () => {
  it("confines output to named milestone folders and rejects path-like arguments", () => {
    const root = resolve("workspace");
    expect(outputOptions(root, { milestone: "M12", prefix: "v16-proof" }).folder).toBe(
      resolve(root, "progress/v2/M12"),
    );
    for (const milestone of [undefined, "../M2", "M13", "M2/../../docs", "m2"])
      expect(() => outputOptions(root, { milestone, prefix: "v16" })).toThrow();
    for (const prefix of [
      undefined,
      "",
      "../history",
      "C:\\outside",
      "v16/photo",
      "v16.svg",
      "a".repeat(65),
    ])
      expect(() => outputOptions(root, { milestone: "M2", prefix })).toThrow();
  });

  it("enforces real device dimensions and the evidence byte budget", () => {
    const png = Buffer.alloc(25);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(690, 20);
    expect(pngInfo(png, 1080, 690)).toEqual({ width: 1080, height: 690, bytes: 25 });
    expect(() => pngInfo(png, 720, 460)).toThrow("device-pixel");
    expect(() => pngInfo(Buffer.alloc(25), 1080, 690)).toThrow("PNG");
    const oversized = Buffer.alloc(pngBudget + 1);
    png.copy(oversized);
    expect(() => pngInfo(oversized, 1080, 690)).toThrow("300 KiB");
  });
});
