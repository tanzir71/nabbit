import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { shelfApi } from "./api";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({ startDrag: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it("passes only the validated plan to the native plugin, holds the source surface and always releases it", async () => {
  const plan = {
    item: ["C:\\Fixture\\one.txt", "C:\\Fixture\\two.png"],
    icon: "data:image/png;base64,fixture",
    mode: "copy",
  };
  vi.mocked(invoke).mockResolvedValueOnce(plan).mockResolvedValue(undefined);
  vi.mocked(startDrag).mockRejectedValueOnce(new Error("fixture Shell denial"));
  await expect(shelfApi.drag(["one", "two"])).rejects.toThrow("fixture Shell denial");
  expect(invoke).toHaveBeenNthCalledWith(1, "shelf_drag_plan", { ids: ["one", "two"] });
  expect(startDrag).toHaveBeenCalledWith(plan, expect.any(Function));
  expect(invoke).toHaveBeenNthCalledWith(2, "shelf_drag_active", { active: true });
  expect(invoke).toHaveBeenLastCalledWith("shelf_drag_active", { active: false });
});
it("never starts a native drag for an invalid, stale or missing-file plan", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Missing file"));
  await expect(shelfApi.drag(["gone"])).rejects.toThrow("Missing file");
  expect(startDrag).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
});
