import { invoke } from "@tauri-apps/api/core";
import { startDrag, type Options } from "@crabnebula/tauri-plugin-drag";
export interface ShelfItem {
  id: string;
  path: string;
  name: string;
  kind: "image" | "video" | "file";
  size: number | null;
  available: boolean;
  cloud?: boolean;
}
export const shelfApi = {
  list: () => invoke<ShelfItem[]>("shelf_list"),
  preview: (id: string) => invoke<string | null>("shelf_preview", { id }),
  add: (paths: string[]) => invoke<ShelfItem[]>("shelf_add", { paths }),
  remove: (ids: string[] | null) => invoke<void>("shelf_remove", { ids }),
  copy: (ids: string[] | null) => invoke<void>("shelf_copy_paths", { ids }),
  drag: async (ids: string[]) => {
    const plan = await invoke<Options>("shelf_drag_plan", { ids });
    await invoke("shelf_drag_active", { active: true });
    try {
      let result = "Cancelled";
      await startDrag(plan, (event) => {
        result = event.result;
      });
      return result;
    } finally {
      await invoke("shelf_drag_active", { active: false });
    }
  },
};
