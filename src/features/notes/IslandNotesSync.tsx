import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { tackApi, type TackSyncSnapshot } from "./tackApi";
import { SyncState } from "./SyncState";
import { IslandAsset } from "../../surfaces/island/IslandAsset";

// This component exists only while the Notes module is expanded. Rust owns retries.
export function IslandNotesSync({ open, recent = false }: { open: () => void; recent?: boolean }) {
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
    <footer className={`island-notes-sync ${recent ? "island-notes-sync--recent" : ""}`}>
      <h1 className="sr-only">Notes</h1>
      {snapshot ? (
        <SyncState
          snapshot={snapshot}
          compact
          act={recent ? undefined : open}
          actionLabel="Open Nabbit"
          titleOverride={
            recent && snapshot.state === "upToDate" && !snapshot.pending && snapshot.lastSynced
              ? "Synced with Tack"
              : undefined
          }
          iconOverride={
            recent && snapshot.state === "upToDate" ? (
              <IslandAsset group="9:200" name="iconCloud" />
            ) : undefined
          }
        />
      ) : (
        <span>Sync status unavailable · Open Notes in Nabbit</span>
      )}
      {recent && (
        <button className="island-all-notes" onClick={open}>
          <IslandAsset group="9:200" name="iconArrowUpRight" /> All notes
        </button>
      )}
    </footer>
  );
}
