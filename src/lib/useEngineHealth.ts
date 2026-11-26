import { useEffect, useState } from "react";
import { api } from "./ipc";
import type { EngineStatus } from "./types";

export function useEngineHealth() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      events = 0,
      stop: (() => void) | undefined;
    void api
      .onEvent<EngineStatus>("engine:health", (next) => {
        events++;
        if (active) setStatus(next);
      })
      .then(async (unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        const revision = events;
        const next = await api.getEngineStatus();
        if (active && revision === events) setStatus(next);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  const run = async (action: "check" | "update", channel?: "stable" | "nightly") => {
    if (working || status?.busy) return;
    setWorking(true);
    setError("");
    try {
      setStatus(await (action === "check" ? api.checkEngine() : api.repairEngine(channel)));
    } catch {
      setError("The engine could not be checked. Try again.");
    } finally {
      setWorking(false);
    }
  };
  return { status, busy: working || Boolean(status?.busy), error, run };
}
