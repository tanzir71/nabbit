import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../lib/ipc";
import { useTheme } from "../../lib/useTheme";
import type { AppSettings } from "../../lib/types";
import { toolsApi, type Tool } from "./api";
import { mediaApi, type MediaIntent } from "./mediaApi";
import { DocumentReview } from "./DocumentReview";
import { ImageReview } from "./ImageReview";
import { isImagePath } from "./imageApi";
import { MediaReview } from "./MediaReview";
import { desiredReviewHeight } from "./mediaLayout";
import { Button } from "../../components/Button";
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
  const inputs = intent?.inputs?.length ? intent.inputs : intent?.input ? [intent.input] : [];
  const images = inputs.length > 0 && inputs.every(isImagePath);
  const multiple =
    tool?.category === "images" ||
    (tool && ["fit-size", "strip-metadata"].includes(tool.id) && images) ||
    (tool && ["merge-pdf", "images-pdf"].includes(tool.id));
  return (
    <main
      className="media-sheet-host"
      style={{ width: tool?.category === "images" || isImagePath(intent?.input ?? "") ? 460 : 440 }}
      ref={root}
    >
      {error ? (
        <section className="media-review">
          <p role="alert">{error}</p>
          <button onClick={close}>Close</button>
        </section>
      ) : intent && tool ? (
        inputs.length > 1 && !multiple ? (
          <MediaInputChoice key={intent.id} intent={intent} inputs={inputs} close={close} />
        ) : tool.category === "documents" ? (
          <DocumentReview key={intent.id} tool={tool} inputs={inputs} close={close} />
        ) : tool.category === "images" ||
          (["fit-size", "strip-metadata"].includes(tool.id) && isImagePath(intent.input)) ? (
          <ImageReview
            key={intent.id}
            tool={tool}
            inputs={inputs}
            initialPreset={intent.presetId}
            close={close}
          />
        ) : (
          <MediaReview
            key={intent.id}
            tool={tool}
            input={intent.input}
            initialPreset={intent.presetId}
            close={close}
          />
        )
      ) : (
        <div className="media-review" role="status">
          {intent ? "Opening media review…" : "Choose a media tool to begin."}
        </div>
      )}
    </main>
  );
}
export function MediaInputChoice({
  intent,
  inputs,
  close,
}: {
  intent: MediaIntent;
  inputs: string[];
  close: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    working = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <section className="media-review">
      <header className="media-heading">
        <h1>Choose a file to review</h1>
      </header>
      <p>This tool reviews one file at a time. All {inputs.length} files stay in your batch.</p>
      <div className="media-input-choices">
        {inputs.map((path, index) => (
          <Button
            key={path + index}
            variant="secondary"
            title={path}
            disabled={busy}
            onClick={async () => {
              if (working.current) return;
              working.current = true;
              setBusy(true);
              setError("");
              try {
                await mediaApi.open({
                  ...intent,
                  id: crypto.randomUUID(),
                  input: path,
                  inputs: [path],
                });
              } catch (reason) {
                if (alive.current) setError(String(reason));
              } finally {
                working.current = false;
                if (alive.current) setBusy(false);
              }
            }}
          >
            {path.split(/[\\/]/).pop() ?? path}
          </Button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      <footer>
        <Button variant="ghost" disabled={busy} onClick={close}>
          Close
        </Button>
      </footer>
    </section>
  );
}
