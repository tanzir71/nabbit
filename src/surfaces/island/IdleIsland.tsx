import { useEffect, useRef } from "react";
import { observeIslandInput } from "../../lib/islandInput";
import { connectIslandVisibility } from "../../lib/islandVisibility";
import { connectIslandActivity, getIslandStore } from "../../lib/islandActivity";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function IdleIsland() {
  const host = useRef<HTMLElement>(null),
    pill = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !pill.current || !("__TAURI_INTERNALS__" in window)) return;
    const input = observeIslandInput(pill.current, host.current);
    const visibility = connectIslandVisibility(host.current);
    const store = getIslandStore(getCurrentWindow().label);
    const activity = connectIslandActivity(store);
    const root = host.current;
    const update = () => {
      root.dataset.islandState = store.getState().state;
    };
    update();
    const unsubscribe = store.subscribe(update);
    return () => {
      visibility.dispose();
      activity.dispose();
      unsubscribe();
      void input.dispose();
    };
  }, []);
  return (
    <main
      ref={host}
      className="island-host"
      aria-label="Nabbit island"
      style={{ opacity: "__TAURI_INTERNALS__" in window ? 0 : 1 }}
    >
      <div ref={pill} className="island-idle" aria-hidden="true" />
    </main>
  );
}
