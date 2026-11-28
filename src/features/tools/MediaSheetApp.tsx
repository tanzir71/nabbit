import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../lib/ipc";
import { useTheme } from "../../lib/useTheme";
import type { AppSettings } from "../../lib/types";
import { toolsApi, type Tool } from "./api";
import { mediaApi, type MediaIntent } from "./mediaApi";
import { MediaReview } from "./MediaReview";
import { desiredReviewHeight } from "./mediaLayout";
import "./media.css";
export default function MediaSheetApp() {
  const [intent, setIntent] = useState<MediaIntent | null>(null),
    [tools, setTools] = useState<Tool[]>([]),
    [settings, setSettings] = useState<AppSettings | null>(null),
    [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useTheme(settings?.theme);
  useEffect(() => {
    let active = true,
      revision = 0,
      stop: (() => void) | undefined;
    const registration = listen<MediaIntent>("tools:sheet", ({ payload }) => {
      if (active) {
        revision++;
        setIntent(payload);
        setError("");
      }
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    void Promise.all([registration, api.getSettings(), toolsApi.catalog()])
      .then(async ([, settings, tools]) => {
        const initial = await mediaApi.current();
        if (active) {
          if (!revision) setIntent(initial);
          setSettings(settings);
          setTools(tools);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (!intent || !root.current) return;
    let active = true,
      queued = false;
    const report = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (active && root.current)
          void mediaApi.ready(intent.id, desiredReviewHeight(root.current)).catch((reason) => {
            if (active) setError(String(reason));
          });
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(root.current);
    const mutations = new MutationObserver(report);
    mutations.observe(root.current, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    void document.fonts.ready.then(report);
    report();
    return () => {
      active = false;
      observer.disconnect();
      mutations.disconnect();
    };
  }, [intent]);
  const close = () => {
    if (!intent) return;
    const id = intent.id;
    void mediaApi
      .close(id)
      .then(() => setIntent((value) => (value?.id === id ? null : value)))
      .catch((reason) => setError(String(reason)));
  };
  const tool = tools.find((t) => t.id === intent?.toolId);
  return (
    <main className="media-sheet-host" ref={root}>
      {error ? (
        <section className="media-review">
          <p role="alert">{error}</p>
          <button onClick={close}>Close</button>
        </section>
      ) : intent && tool ? (
        <MediaReview key={intent.id} tool={tool} input={intent.input} close={close} />
      ) : (
        <div className="media-review" role="status">
          {intent ? "Opening media review…" : "Choose a media tool to begin."}
        </div>
      )}
    </main>
  );
}
