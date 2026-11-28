import { invoke } from "@tauri-apps/api/core";
import type { ClipboardEntry } from "../../lib/types";
import type { Tool } from "../tools/api";
import { mediaApi } from "../tools/mediaApi";
export interface TextTool {
  id: string;
  name: string;
  group: "case" | "lines" | "encoding" | "main";
}
export interface ClipboardContextSnapshot {
  entry: ClipboardEntry;
  kind: "text" | "json" | "link" | "video" | "image" | "files" | "path";
  tools: Tool[];
  textTools: TextTool[];
  selection: boolean;
}
export const contextApi = {
  snapshot: (id?: string, explicit = false) =>
    invoke<ClipboardContextSnapshot | null>("clipboard_context", { id: id ?? null, explicit }),
  dismiss: () => invoke<void>("clipboard_context_dismiss"),
  transform: (id: string, operation: string, requestId: string) =>
    invoke<ClipboardEntry>("clipboard_transform", { request: { id, operation, requestId } }),
  action: (id: string, action: "save-image" | "shelf" | "pin" | "reveal") =>
    invoke<string>("clipboard_context_action", { id, action }),
  inputs: (id: string, toolId: string) => invoke<string[]>("clipboard_tool_inputs", { id, toolId }),
  review: async (id: string, toolId: string) => {
    const inputs = await contextApi.inputs(id, toolId);
    await mediaApi.open({ id: crypto.randomUUID(), toolId, input: inputs[0] ?? "", inputs });
  },
};
