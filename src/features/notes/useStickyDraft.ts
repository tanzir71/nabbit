import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { stickyApi, type StickyDraft, type StickyProfile, type StickySnapshot } from "./stickyApi";
import { notesApi, type NoteCaptureRequest } from "./api";
import { tackApi, type TackSyncSnapshot } from "./tackApi";
import type { CardValue, NotePatch, StoredNote } from "./types";
import type { ThemePreference } from "../../lib/theme";
import { sameScope } from "./captureDraft";
const fields = ["title", "body", "items"] as const;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const stickyPatch = (base: CardValue, value: CardValue): NotePatch =>
  Object.fromEntries(fields.filter((k) => !equal(base[k], value[k])).map((k) => [k, value[k]]));
const edits = (value: CardValue) => ({ title: value.title, body: value.body, items: value.items });
const cacheKey = (s: StickySnapshot) =>
  `nabbit.sticky.draft.v1.${s.binding.scope?.key ?? "local"}.${s.binding.cardId}`;
interface Session {
  snapshot: StickySnapshot;
  base: StoredNote;
  value: CardValue;
  sequence: number;
  conflict: boolean;
  copyId: string;
  copyRequest?: NoteCaptureRequest;
}
export function useStickyDraft() {
  const [theme, setTheme] = useState<ThemePreference>();
  const [view, setView] = useState<Session | null>(null),
    [sync, setSync] = useState<TackSyncSnapshot | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [closeChoice, setCloseChoice] = useState(false),
    [liveUpdates, setLiveUpdates] = useState(true);
  const session = useRef<Session | null>(null),
    alive = useRef(true),
    working = useRef<Promise<boolean> | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout>>(),
    checkpointTimer = useRef<ReturnType<typeof setTimeout>>(),
    refreshTicket = useRef(0),
    syncVersion = useRef(0),
    eventsOK = useRef(true),
    transitioning = useRef(false);
  const operations = useRef({
    refresh: async () => {},
    close: async () => {},
    flush: async (): Promise<boolean> => false,
  });
  const publish = (s: Session) => {
    session.current = s;
    if (alive.current) setView({ ...s });
  };
  const dirty = (s: Session) => Object.keys(stickyPatch(s.base.value, s.value)).length > 0;
  const locked = (s: Session) =>
    transitioning.current ||
    s.snapshot.content.status !== "ready" ||
    s.snapshot.content.readOnly ||
    s.conflict ||
    !eventsOK.current;
  const cancelTimers = () => {
    clearTimeout(saveTimer.current);
    clearTimeout(checkpointTimer.current);
  };
  const cache = (s: Session) => {
    try {
      if (dirty(s))
        localStorage.setItem(
          cacheKey(s.snapshot),
          JSON.stringify({
            base: s.base,
            value: s.value,
            copyId: s.copyId,
            copyRequest: s.copyRequest,
          }),
        );
      else localStorage.removeItem(cacheKey(s.snapshot));
    } catch {
      if (alive.current)
        setError(
          "Device storage is unavailable. Keep this window open until the draft is saved or checkpointed.",
        );
    }
  };
  const checkpoint = async (s: Session) => {
    await stickyApi.checkpoint(s.snapshot.binding, s.sequence, {
      base: s.base,
      value: s.value,
      copyId: s.copyId,
      copyRequest: s.copyRequest,
    });
  };
  const accept = (snapshot: StickySnapshot, replace = false) => {
    setTheme(snapshot.theme);
    const current = session.current;
    if (!current || replace) {
      const actual = snapshot.content.note;
      let recovered = snapshot.content.checkpoint?.draft;
      if (!recovered) {
        try {
          const value = JSON.parse(
            localStorage.getItem(cacheKey(snapshot)) ?? "null",
          ) as StickyDraft | null;
          if (
            value?.base.value.id === snapshot.binding.cardId &&
            value.value.id === snapshot.binding.cardId &&
            (value.base.scope?.key ?? null) === (snapshot.binding.scope?.key ?? null)
          )
            recovered = value;
        } catch {
          /* Native checkpoint remains authoritative when browser storage cannot be read. */
        }
      }
      const base = recovered?.base ?? actual;
      if (!base) {
        setLoading(false);
        setError("This note is no longer available. Open another note from Nabbit.");
        return;
      }
      const value = recovered?.value ?? base.value;
      const conflict = !!(
        recovered &&
        actual &&
        Object.keys(stickyPatch(actual.value, value)).length &&
        !equal(edits(base.value), edits(actual.value))
      );
      const updatedBase = actual && !conflict ? actual : base;
      const next: Session = {
        snapshot,
        base: updatedBase,
        value: { ...(actual?.value ?? value), ...edits(value) },
        sequence: 1,
        conflict,
        copyId: recovered?.copyId ?? crypto.randomUUID(),
        copyRequest: recovered?.copyRequest,
      };
      publish(next);
      cache(next);
      if (recovered)
        void checkpoint(next)
          .then(() => {
            if (!dirty(next)) return stickyApi.clear(next.snapshot.binding, next.sequence);
            if (alive.current && !locked(next)) schedule();
          })
          .catch(() => {
            if (alive.current)
              setError(
                "Your recovered draft is visible, but checkpointing failed. Keep this window open.",
              );
          });
      if (conflict)
        setError(
          "This note changed elsewhere. Your draft is kept. Reload or save it as a new card.",
        );
    } else {
      const next = { ...current, snapshot };
      const actual = snapshot.content.note;
      if (snapshot.content.status === "ready" && actual && !working.current) {
        if (!dirty(current) || equal(edits(current.value), edits(actual.value))) {
          next.base = actual;
          next.value = actual.value;
          next.conflict = false;
          cache(next);
          void stickyApi.clear(snapshot.binding, next.sequence).catch(() => {});
        } else if (equal(edits(current.base.value), edits(actual.value))) {
          next.base = actual;
          next.value = { ...actual.value, ...edits(current.value) };
        } else {
          next.conflict = true;
          next.value = { ...actual.value, ...edits(current.value) };
          setError(
            "This note changed elsewhere. Your draft is kept. Reload or save it as a new card.",
          );
        }
      }
      publish(next);
      if (locked(next)) cancelTimers();
    }
    if (alive.current) setLoading(false);
  };
  const refresh = async () => {
    const ticket = ++refreshTicket.current,
      version = syncVersion.current;
    try {
      const [snapshot, status] = await Promise.all([stickyApi.snapshot(), tackApi.syncSnapshot()]);
      if (!alive.current || ticket !== refreshTicket.current) return;
      accept(snapshot);
      if (version === syncVersion.current) setSync(status);
    } catch {
      if (alive.current) {
        setLoading(false);
        setError("This note could not be refreshed. Your draft is kept.");
      }
    }
  };
  const flush = async (): Promise<boolean> => {
    cancelTimers();
    if (working.current) {
      await working.current;
      return operations.current.flush();
    }
    const s = session.current;
    if (!s) return false;
    if (!dirty(s)) {
      try {
        await stickyApi.clear(s.snapshot.binding, s.sequence);
        if (alive.current) setError("");
        return true;
      } catch {
        if (alive.current)
          setError(
            "The older draft checkpoint could not be cleared. Keep this window open and retry.",
          );
        return false;
      }
    }
    // Claim the operation before its first await: blur, quiet-time save and
    // close may all request a flush while SQLite is writing the checkpoint.
    const operation = (async () => {
      try {
        await checkpoint(s);
        if (locked(s)) return false;
        if (alive.current) {
          setSaving(true);
          setError("");
        }
        const saved = await stickyApi.save(
          s.snapshot.binding,
          s.sequence,
          s.base,
          stickyPatch(s.base.value, s.value),
        );
        const latest = session.current;
        if (
          !alive.current ||
          !latest ||
          latest.snapshot.binding.instance !== s.snapshot.binding.instance
        )
          return false;
        const next = {
          ...latest,
          base: saved,
          value:
            latest.sequence === s.sequence
              ? saved.value
              : { ...saved.value, ...edits(latest.value) },
          conflict: false,
        };
        publish(next);
        cache(next);
        if (dirty(next)) await checkpoint(next);
        return true;
      } catch {
        if (alive.current)
          setError("Saving failed or this note changed elsewhere. Your draft is kept.");
        return false;
      } finally {
        working.current = null;
        if (alive.current) setSaving(false);
      }
    })();
    working.current = operation;
    const ok = await operation;
    if (alive.current) {
      await refresh();
      if (ok && session.current && dirty(session.current) && !locked(session.current)) schedule();
    }
    return ok;
  };
  function schedule() {
    cancelTimers();
    const s = session.current;
    if (!s || !dirty(s)) return;
    checkpointTimer.current = setTimeout(() => {
      const latest = session.current;
      if (latest)
        void checkpoint(latest).catch(() => {
          if (alive.current)
            setError("Draft checkpointing failed. Keep this window open until it is saved.");
        });
    }, 200);
    if (!locked(s))
      saveTimer.current = setTimeout(() => {
        void operations.current.flush();
      }, 650);
  }
  const update = <K extends "title" | "body" | "items">(key: K, value: CardValue[K]) => {
    const s = session.current;
    if (!s || locked(s)) return;
    const next = {
      ...s,
      value: { ...s.value, [key]: value },
      sequence: s.sequence + 1,
      copyId: crypto.randomUUID(),
      copyRequest: undefined,
    };
    publish(next);
    cache(next);
    schedule();
    if (!dirty(next))
      void stickyApi.clear(next.snapshot.binding, next.sequence).catch(() => {
        if (alive.current)
          setError("The older draft checkpoint could not be cleared. Retry save before closing.");
      });
  };
  const close = async () => {
    if (transitioning.current) return;
    const s = session.current;
    if (!s) {
      try {
        await stickyApi.leave();
      } catch {
        if (alive.current) setError("This window could not be closed. Reopen Nabbit to retry.");
      }
      return;
    }
    const saved = await flush();
    const latest = session.current;
    if (!alive.current || !latest) return;
    if (!saved || dirty(latest)) {
      if (alive.current) setCloseChoice(true);
      return;
    }
    try {
      transitioning.current = true;
      if (alive.current) setSaving(true);
      await stickyApi.close(latest.snapshot.binding);
    } catch {
      if (alive.current) setError("This window could not be closed. Your note stays here.");
    } finally {
      transitioning.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const discardClose = async () => {
    const s = session.current;
    if (!s || transitioning.current) return;
    transitioning.current = true;
    if (alive.current) setSaving(true);
    cancelTimers();
    try {
      if (working.current) await working.current;
      if (!alive.current) return;
      localStorage.removeItem(cacheKey(s.snapshot));
      await stickyApi.close(s.snapshot.binding, true);
    } catch {
      if (alive.current) setError("The window could not be closed. Your draft stays here.");
    } finally {
      transitioning.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const reload = async () => {
    const s = session.current;
    if (!s || transitioning.current) return;
    transitioning.current = true;
    if (alive.current) setSaving(true);
    cancelTimers();
    try {
      if (working.current) await working.current;
      if (!alive.current) return;
      const snapshot = await stickyApi.reload(s.snapshot.binding);
      if (!alive.current) return;
      localStorage.removeItem(cacheKey(s.snapshot));
      accept(snapshot, true);
      setError("");
    } catch {
      if (alive.current)
        setError(
          "Return to this note's original workspace before reloading. Your draft stays here.",
        );
    } finally {
      transitioning.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const copy = async () => {
    const s = session.current;
    if (!s || s.snapshot.content.readOnly || transitioning.current) return;
    transitioning.current = true;
    cancelTimers();
    if (alive.current) setSaving(true);
    try {
      if (working.current) await working.current;
      if (!alive.current) return;
      const c = s.value;
      const request: NoteCaptureRequest =
        s.copyRequest && sameScope(s.copyRequest.expectedScope, s.snapshot.content.currentScope)
          ? s.copyRequest
          : {
              requestId: s.copyRequest ? crypto.randomUUID() : s.copyId,
              expectedScope: s.snapshot.content.currentScope,
              draft: {
                title: c.title,
                body: c.body,
                kind: c.kind,
                url: c.url,
                labels: c.labels,
                priority: c.priority,
                color: c.color,
              },
              patch: {
                items: c.items,
                pinned: c.pinned,
                completed: c.completed,
                ...(c.status ? { status: c.status } : {}),
              },
              reminders: [],
            };
      const frozen = {
        ...s,
        sequence: s.sequence + 1,
        copyId: request.requestId,
        copyRequest: request,
      };
      publish(frozen);
      cache(frozen);
      await checkpoint(frozen);
      await stickyApi.copy(s.snapshot.binding, request);
      if (!alive.current) return;
      localStorage.removeItem(cacheKey(s.snapshot));
      await stickyApi.close(s.snapshot.binding, true);
    } catch {
      if (alive.current)
        setError(
          "The new card could not be saved or opened. Your draft is kept; unchanged retries will reuse its capture ID.",
        );
    } finally {
      transitioning.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const openEditor = async () => {
    if (!(await flush())) return;
    const s = session.current;
    if (!s) return;
    try {
      await notesApi.open({
        kind: "card",
        id: s.snapshot.binding.cardId,
        expectedScope: s.snapshot.binding.scope,
      });
    } catch {
      if (alive.current) setError("The full editor could not be opened. Your note stays here.");
    }
  };
  operations.current = { refresh, close, flush };
  useEffect(() => {
    alive.current = true;
    let active = true;
    const stops: Array<() => void> = [];
    const install = async (event: string, handler: (payload: unknown) => void) => {
      const stop = await listen(event, (e) => {
        if (active) handler(e.payload);
      });
      if (!active) stop();
      else stops.push(stop);
    };
    void Promise.allSettled([
      install("nabbit://theme-preference", (payload) => setTheme(payload as ThemePreference)),
      install("notes:updated", () => {
        void operations.current.refresh();
      }),
      install("tack:sync", (payload) => {
        syncVersion.current++;
        setSync(payload as TackSyncSnapshot);
      }),
      install("sticky:profile", (payload) => {
        const s = session.current;
        if (s) publish({ ...s, snapshot: { ...s.snapshot, profile: payload as StickyProfile } });
      }),
      install("sticky:close-requested", () => {
        void operations.current.close();
      }),
      install("sticky:placement-error", () =>
        setError("This window's placement could not be saved."),
      ),
    ]).then((results) => {
      if (!active) return;
      eventsOK.current = results.every((r) => r.status === "fulfilled");
      setLiveUpdates(eventsOK.current);
      void operations.current.refresh();
    });
    return () => {
      active = false;
      alive.current = false;
      cancelTimers();
      stops.forEach((stop) => stop());
    };
  }, []);
  const s = view;
  return {
    session: s,
    theme,
    sync,
    error,
    loading,
    saving,
    closeChoice,
    setCloseChoice,
    liveUpdates,
    dirty: s ? dirty(s) : false,
    locked: s ? locked(s) : true,
    update,
    flush,
    close,
    discardClose,
    reload,
    copy,
    openEditor,
    refresh,
  };
}
