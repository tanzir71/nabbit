import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { tackApi, type TackSyncSnapshot } from "./tackApi";
import { SyncState } from "./SyncState";

// This component exists only while the Notes module is expanded. Rust owns retries.
export function IslandNotesSync({ open }: { open: () => void }) {
  const [snapshot, setSnapshot] = useState<TackSyncSnapshot | null>(null);
  useEffect(() => {
    let active = true,
      version = 0,
      stop: (() => void) | undefined;
    void listen<TackSyncSnapshot>("tack:sync", (event) => {
      version++;
      if (active) setSnapshot(event.payload);
    })
      .then(async (unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        const request = version;
        const initial = await tackApi.syncSnapshot();
        if (active && request === version) setSnapshot(initial);
      })
      .catch(() => {
        if (active) setSnapshot(null);
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  return (
    <footer className="island-notes-sync">
      <h1 className="sr-only">Notes</h1>
      {snapshot ? (
        <SyncState snapshot={snapshot} compact act={open} actionLabel="Open Nabbit" />
      ) : (
        <span>Sync status unavailable · Open Notes in Nabbit</span>
      )}
    </footer>
  );
}
