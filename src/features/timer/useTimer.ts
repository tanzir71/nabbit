import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { timerApi, type TimerSnapshot, type TimerAction } from "./api";
let sequence = 0;
export function useTimer() {
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const latest = useRef<TimerSnapshot | null>(null),
    pending = useRef(false);
  useEffect(() => {
    let active = true,
      revision = -1,
      stop: (() => void) | undefined,
      watch: Promise<void> | undefined;
    const lease = `timer-${++sequence}`;
    const receive = (value: TimerSnapshot) => {
      if (active && value.revision >= revision) {
        revision = value.revision;
        if (latest.current && value.revision < latest.current.revision) return;
        latest.current = value;
        setSnapshot(value);
        setError("");
      }
    };
    void listen<TimerSnapshot>("nabbit://timer", (e) => receive(e.payload))
      .then(async (unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        watch = timerApi.view(lease, true);
        await watch;
        if (active) receive(await timerApi.snapshot());
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
      stop?.();
      if (watch) void watch.then(() => timerApi.view(lease, false)).catch(() => {});
    };
  }, []);
  const act = useCallback(async (action: TimerAction) => {
    if (!latest.current || pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await timerApi.action(latest.current.generation, action);
      if (next.revision >= latest.current.revision) latest.current = next;
      setSnapshot((current) => (!current || next.revision >= current.revision ? next : current));
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, []);
  return { snapshot, error, busy, act };
}
