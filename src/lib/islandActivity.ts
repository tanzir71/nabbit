import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ActivityMessage, ActivitySnapshot } from "./activity";
import {
  createIslandStore,
  emptyMemory,
  tabs,
  type IslandMemory,
  type IslandStore,
} from "../store/islandStore";
export interface ActivityTransport {
  subscribe: (receive: (message: ActivityMessage) => void) => Promise<() => void>;
  snapshot: () => Promise<ActivitySnapshot>;
}
const native: ActivityTransport = {
  subscribe: (receive) =>
    listen<ActivityMessage>("nabbit://island", ({ payload }) => receive(payload)),
  snapshot: () => invoke("get_activity_snapshot"),
};
const stores = new Map<string, IslandStore>();
function memoryKey(label: string) {
  return `nabbit.island.ui.v1.${label}`;
}
export function loadIslandMemory(label: string, storage: Pick<Storage, "getItem">): IslandMemory {
  try {
    const value = JSON.parse(storage.getItem(memoryKey(label)) ?? "null");
    if (!value || !tabs.includes(value.tab) || typeof value.searchText !== "string")
      return emptyMemory();
    const strings = Object.entries(value.filters ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    const scroll = Object.fromEntries(
      Object.entries(value.scroll ?? {}).filter(
        ([key, offset]) =>
          tabs.includes(key as (typeof tabs)[number]) &&
          typeof offset === "number" &&
          Number.isFinite(offset) &&
          offset >= 0,
      ),
    );
    return {
      tab: value.tab,
      searchText: value.searchText,
      filters: Object.fromEntries(strings),
      scroll,
    };
  } catch {
    return emptyMemory();
  }
}
export function getIslandStore(label: string): IslandStore {
  let store = stores.get(label);
  if (!store) {
    store = createIslandStore(label, loadIslandMemory(label, localStorage));
    stores.set(label, store);
  }
  return store;
}
/** Backend deadlines never become JS timers. Only live hover/Peek leave can schedule one. */
export function connectIslandActivity(
  store: IslandStore,
  options: {
    transport?: ActivityTransport;
    now?: () => number;
    storage?: Pick<Storage, "setItem">;
    onError?: (error: unknown) => void;
  } = {},
) {
  const transport = options.transport ?? native,
    now = options.now ?? (() => performance.now());
  const storage = options.storage ?? localStorage;
  let live = true,
    stop: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    due: number | null = null;
  let previous = store.getState();
  const changed = () => {
    const state = store.getState();
    if (
      state.tab !== previous.tab ||
      state.filters !== previous.filters ||
      state.searchText !== previous.searchText ||
      state.scroll !== previous.scroll
    ) {
      try {
        storage.setItem(
          memoryKey(state.label),
          JSON.stringify({
            tab: state.tab,
            filters: state.filters,
            searchText: state.searchText,
            scroll: state.scroll,
          }),
        );
      } catch {
        /* UI memory is best effort. */
      }
    }
    previous = state;
    const deadline =
      state.state === "live" ? state.peekAt : state.state === "peek" ? state.closeAt : null;
    if (deadline === due) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    due = deadline;
    if (deadline !== null)
      timer = setTimeout(
        () => {
          timer = undefined;
          due = null;
          if (live) {
            store.getState().dispatch({ type: "clock", now: now() });
            changed();
          }
        },
        Math.max(1, Math.ceil(deadline - now())),
      );
  };
  const unsubscribe = store.subscribe(changed);
  changed();
  const ready = transport
    .subscribe((event) => {
      if (live) store.getState().dispatch({ type: "backend", snapshot: event.snapshot, event });
    })
    .then(async (unlisten) => {
      if (!live) {
        unlisten();
        return;
      }
      stop = unlisten;
      const snapshot = await transport.snapshot();
      if (live) store.getState().dispatch({ type: "backend", snapshot });
    })
    .catch(
      options.onError ?? ((error: unknown) => console.warn("Island activities unavailable", error)),
    );
  return {
    ready,
    dispose: () => {
      live = false;
      unsubscribe();
      stop?.();
      stop = undefined;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
