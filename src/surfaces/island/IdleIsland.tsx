import { useEffect, useRef } from "react";
import { observeIslandInput } from "../../lib/islandInput";

export function IdleIsland() {
  const host = useRef<HTMLElement>(null),
    pill = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !pill.current || !("__TAURI_INTERNALS__" in window)) return;
    const input = observeIslandInput(pill.current, host.current);
    return () => {
      void input.dispose();
    };
  }, []);
  return (
    <main ref={host} className="island-host" aria-label="Nabbit island">
      <div ref={pill} className="island-idle" aria-hidden="true" />
    </main>
  );
}
