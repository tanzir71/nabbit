import { useEffect, useRef, useState } from "react";
import { contextApi } from "../clipboard/contextApi";
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
  preferSave = false,
}: {
  entry: ClipboardEntry;
  download: (url: string) => Promise<void>;
  preferSave?: boolean;
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
      if (!alive.current || owner !== generation.current)
        throw new Error("The link changed before saving");
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
        {isVideo(entry.content) && !preferSave && (
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
          className={preferSave || !isVideo(entry.content) ? "is-signal" : ""}
          disabled={busy}
          onClick={() => void save()}
        >
          Save link
        </button>
        {preferSave && isVideo(entry.content) && (
          <button
            type="button"
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
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await contextApi.transform(entry.id, "clean-link", crypto.randomUUID());
              return "Clean link copied";
            })
          }
        >
          Clean link
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await contextApi.review(entry.id, "encode-qr");
              return "QR review opened";
            })
          }
        >
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
