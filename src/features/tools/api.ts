import { invoke } from "@tauri-apps/api/core";
export interface Tool {
  id: string;
  name: string;
  category: string;
  icon: string;
  keywords: string[];
  accepts: { filetypes: string[]; text: boolean; link: boolean; image: boolean };
  presets: string[];
  form: Array<{
    key: string;
    label: string;
    min: number;
    max: number;
    default: number;
    advanced: boolean;
  }>;
}
export interface ToolPreset {
  id: string;
  name: string;
  maxMb: number | null;
  quality: number;
}
export interface ToolJob {
  id: string;
  request: { toolId: string; input: string; presetId: string };
  preset: ToolPreset;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "undone";
  percent: number;
  createdAt: string;
  output: string | null;
  beforeBytes: number;
  afterBytes: number;
  note: string | null;
  error: string | null;
}
export const toolsApi = {
  pick: (toolId: string) => invoke<string | null>("tool_pick_input", { toolId }),
  catalog: () => invoke<Tool[]>("tool_catalog"),
  presets: () => invoke<ToolPreset[]>("tool_presets"),
  savePreset: (preset: ToolPreset) => invoke<void>("tool_save_preset", { preset }),
  jobs: () => invoke<ToolJob[]>("tool_jobs"),
  start: (tool: Tool, input: string) =>
    invoke<ToolJob>("tool_start", {
      request: {
        requestId: crypto.randomUUID(),
        toolId: tool.id,
        input,
        presetId: tool.presets[0],
      },
    }),
  action: (action: "cancel" | "retry" | "reveal" | "undo", id: string) =>
    invoke(`tool_${action}`, { id }),
};
export function acceptsFile(tool: Tool, path: string) {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  return !!ext && tool.accepts.filetypes.includes(ext);
}
