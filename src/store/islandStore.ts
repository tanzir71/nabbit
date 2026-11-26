import { createStore } from "zustand/vanilla";
import type {
  ActivityItem,
  ActivityMessage,
  ActivitySnapshot,
  ActivityView,
  Gate,
} from "../lib/activity";
export type IslandMode = "hidden" | "idle" | "faded" | "live" | "peek" | "expanded" | "drop";
export const tabs = ["nab", "notes", "clipboard", "files", "media", "timer"] as const;
export type IslandTab = (typeof tabs)[number];
export interface IslandMemory {
  tab: IslandTab;
  filters: Record<string, string>;
  searchText: string;
  scroll: Partial<Record<IslandTab, number>>;
}
export interface IslandModel extends IslandMemory {
  label: string;
  state: IslandMode;
  primary: ActivityItem | null;
  bubble: ActivityItem | null;
  queue: ActivityItem[];
  alert: ActivityItem | null;
  revision: number;
  gate: Gate;
  fullscreen: boolean;
  peekAt: number | null;
  closeAt: number | null;
  dropReturn: IslandMode | null;
}
export type IslandAction =
  | { type: "backend"; snapshot: ActivitySnapshot; event?: ActivityMessage }
  | { type: "enter" | "leave" | "clock"; now: number }
  | { type: "open" | "collapse" | "escape" | "outside" | "dragEnter" | "dragLeave" }
  | { type: "tab"; tab: IslandTab }
  | { type: "filter"; name: string; value: string }
  | { type: "search"; text: string }
  | { type: "scroll"; tab: IslandTab; offset: number };
export const emptyMemory = (): IslandMemory => ({
  tab: "nab",
  filters: {},
  searchText: "",
  scroll: {},
});
export function initialIsland(label: string, memory: IslandMemory = emptyMemory()): IslandModel {
  return {
    ...memory,
    label,
    state: "hidden",
    primary: null,
    bubble: null,
    queue: [],
    alert: null,
    revision: -1,
    gate: "hidden",
    fullscreen: false,
    peekAt: null,
    closeAt: null,
    dropReturn: null,
  };
}
const compact = (model: IslandModel): IslandMode =>
  model.gate === "hidden"
    ? "hidden"
    : model.gate === "faded" && !model.primary
      ? "faded"
      : model.primary
        ? "live"
        : "idle";
const collapsed = (model: IslandModel): IslandModel => ({
  ...model,
  state: compact(model),
  peekAt: null,
  closeAt: null,
  dropReturn: null,
});
function backend(
  model: IslandModel,
  view: ActivityView | undefined,
  revision: number,
): IslandModel {
  const next = {
    ...model,
    revision,
    primary: view?.primary ?? null,
    bubble: view?.bubble ?? null,
    queue: view?.queue ?? [],
    gate: view?.gate ?? "hidden",
    fullscreen: view?.fullscreen ?? false,
  };
  const result = { ...next, alert: next.primary?.alert ? next.primary : null };
  if (next.gate === "hidden" || next.fullscreen) return collapsed(result);
  if (model.state === "expanded") return result;
  if (model.state === "drop")
    return {
      ...result,
      dropReturn:
        model.dropReturn === "expanded"
          ? "expanded"
          : model.dropReturn === "peek" && next.primary
            ? "peek"
            : compact(result),
    };
  if (model.state === "peek" && next.primary) return result;
  const state = compact(result);
  return {
    ...result,
    state,
    peekAt: state === "live" ? model.peekAt : null,
    closeAt: null,
    dropReturn: null,
  };
}
export function islandReducer(model: IslandModel, action: IslandAction): IslandModel {
  switch (action.type) {
    case "backend": {
      if (action.snapshot.revision < model.revision) return model;
      const next = backend(
        model,
        action.snapshot.views.find((view) => view.label === model.label),
        action.snapshot.revision,
      );
      if (action.event?.target && action.event.target !== model.label) return next;
      if (action.event?.kind === "dragEnter") return islandReducer(next, { type: "dragEnter" });
      if (action.event?.kind === "dragLeave") return islandReducer(next, { type: "dragLeave" });
      return next;
    }
    case "enter":
      return model.fullscreen
        ? model
        : model.state === "peek"
          ? { ...model, closeAt: null }
          : model.state === "live" && model.peekAt === null
            ? { ...model, peekAt: action.now + 180 }
            : model;
    case "leave":
      return { ...model, peekAt: null, closeAt: model.state === "peek" ? action.now + 300 : null };
    case "clock":
      if (model.state === "live" && model.peekAt !== null && action.now >= model.peekAt)
        return { ...model, state: "peek", peekAt: null };
      if (model.state === "peek" && model.closeAt !== null && action.now >= model.closeAt)
        return collapsed(model);
      return model;
    case "open":
      return model.gate === "hidden" || model.fullscreen
        ? model
        : { ...model, state: "expanded", peekAt: null, closeAt: null, dropReturn: null };
    case "escape":
    case "outside":
    case "collapse":
      return collapsed(model);
    case "dragEnter":
      return model.state === "hidden" || model.state === "drop" || model.fullscreen
        ? model
        : { ...model, state: "drop", dropReturn: model.state, peekAt: null, closeAt: null };
    case "dragLeave":
      return model.state !== "drop"
        ? model
        : {
            ...model,
            state: model.dropReturn ?? compact(model),
            dropReturn: null,
            peekAt: null,
            closeAt: null,
          };
    case "tab":
      return { ...model, tab: action.tab };
    case "filter":
      return { ...model, filters: { ...model.filters, [action.name]: action.value } };
    case "search":
      return { ...model, searchText: action.text };
    case "scroll":
      return Number.isFinite(action.offset)
        ? { ...model, scroll: { ...model.scroll, [action.tab]: Math.max(0, action.offset) } }
        : model;
  }
}
export function createIslandStore(label: string, memory?: IslandMemory) {
  return createStore<IslandModel & { dispatch: (action: IslandAction) => void }>()((set) => ({
    ...initialIsland(label, memory),
    dispatch: (action) => set((state) => islandReducer(state, action)),
  }));
}
export type IslandStore = ReturnType<typeof createIslandStore>;
