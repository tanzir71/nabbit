import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mediaApi, type MediaSnapshot } from "./api";
export function useMedia() {
  const [snapshot, setSnapshot] = useState<MediaSnapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      revision = -1;
    let unlisten: (() => void) | undefined;
    const receive = (value: MediaSnapshot) => {
      if (active && value.revision >= revision) {
        revision = value.revision;
        setSnapshot(value);
        setError("");
      }
    };
    void listen<MediaSnapshot>("nabbit://media", ({ payload }) => receive(payload))
      .then(async (stop) => {
        if (!active) {
          stop();
          return;
        }
        unlisten = stop;
        receive(await mediaApi.snapshot());
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return { snapshot, error, session: snapshot?.sessions.find((s) => s.id === snapshot.selected) };
}
