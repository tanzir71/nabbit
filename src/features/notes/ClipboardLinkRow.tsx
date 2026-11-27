import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ClipboardEntry } from "../../lib/types";
import { formatRelativeTime } from "../../lib/search";
import { LinkIcon } from "./LinkIcon";
import { notesApi, type NoteCaptureRequest } from "./api";
import { linksApi } from "./linksApi";
import { sameScope } from "./captureDraft";
import { isVideo } from "./linkPresentation";
import "./links.css";
export function ClipboardLinkRow({
  entry,
  download,
}: {
  entry: ClipboardEntry;
  download: (url: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const alive = useRef(true);
  const packet = useRef<NoteCaptureRequest | null>(null),
    generation = useRef(0),
    working = useRef(false);
  useEffect(() => {
    alive.current = true;
    generation.current++;
    packet.current = null;
    working.current = false;
    setBusy(false);
    setMessage("");
    setError("");
    return () => {
      alive.current = false;
    };
  }, [entry.id, entry.content]);
  const run = async (action: () => Promise<string>) => {
    if (working.current) return;
    working.current = true;
    const request = generation.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const text = await action();
      if (alive.current && request === generation.current) setMessage(text);
    } catch {
      if (alive.current && request === generation.current)
        setError("The link action could not finish. Your original link is still here; try again.");
    } finally {
      if (alive.current && request === generation.current) {
        working.current = false;
        setBusy(false);
      }
    }
  };
  const save = () => {
    const owner = generation.current;
    return run(async () => {
      const state = await notesApi.state();
      const cached = packet.current;
      const request: NoteCaptureRequest =
        cached && cached.draft.url === entry.content && sameScope(cached.expectedScope, state.scope)
          ? cached
          : {
              requestId: crypto.randomUUID(),
              expectedScope: state.scope,
              draft: {
                kind: "bookmark",
                url: entry.content,
                title: entry.content,
                priority: "inbox",
                labels: [],
              },
              patch: {},
              reminders: [],
            };
      if (owner === generation.current) packet.current = request;
      const saved = await notesApi.capture(request);
      if (saved.value.id !== request.requestId)
        return "Link already saved · Open Links to edit labels or reminders";
      return saved.scope
        ? "Link saved on this PC; queued for Tack · Links"
        : "Link saved on this PC · Links";
    });
  };
  return (
    <section className="clipboard-link-context" aria-label="Copied link actions">
      <div className="clipboard-link-heading">
        <LinkIcon name="clipboardImgIconLink" />
        <code>{entry.content.replace(/^https?:\/\//i, "")}</code>
        <span>{formatRelativeTime(entry.lastUsedAt)}</span>
      </div>
      <div className="clipboard-link-buttons">
        {isVideo(entry.content) && (
          <button
            type="button"
            className="is-signal"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await download(entry.content);
                return "Ready to download";
              })
            }
          >
            Download
          </button>
        )}
        <button
          type="button"
          className={!isVideo(entry.content) ? "is-signal" : ""}
          disabled={busy}
          onClick={() => void save()}
        >
          Save link
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await writeText(await linksApi.clean(entry.content));
              return "Clean link copied";
            })
          }
        >
          Clean link
        </button>
        <button type="button" disabled title="QR codes are coming with clipboard tools">
          QR code
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await linksApi.openUrl(entry.content);
              return "Link opened";
            })
          }
        >
          Open
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
