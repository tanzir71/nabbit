import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ClipboardEntry } from "../../lib/types";
import { formatRelativeTime } from "../../lib/search";
import { ClipboardLinkRow } from "../notes/ClipboardLinkRow";
import { notesApi, type NoteCaptureRequest } from "../notes/api";
import { sameScope } from "../notes/captureDraft";
import { contextApi, type ClipboardContextSnapshot } from "./contextApi";
import { clipboardApi } from "./api";
import { TextToolsMenu } from "./TextToolsMenu";
import "../notes/links.css";
import "./context.css";
export function ClipboardContext({
  entry,
  download,
  silent = false,
  menu = false,
  closeMenu,
  pasted,
}: {
  entry?: ClipboardEntry;
  download: (url: string) => Promise<void>;
  silent?: boolean;
  menu?: boolean;
  closeMenu?: () => void;
  pasted?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ClipboardContextSnapshot | null>(null),
    [opened, setOpened] = useState(menu),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const alive = useRef(true),
    working = useRef(false),
    generation = useRef({ value: 0 });
  const operationOwner = useRef({ value: 0 }),
    selectionSeen = useRef("");
  const requests = useRef(new Map<string, string>()),
    packet = useRef<NoteCaptureRequest | null>(null);
  const liveEntry = useRef("");
  const id = entry?.id;
  const refresh = useCallback(async () => {
    const current = ++generation.current.value;
    try {
      const next = silent ? null : await contextApi.snapshot(id, menu);
      if (alive.current && current === generation.current.value) {
        if (liveEntry.current !== (next?.entry.id ?? "")) {
          liveEntry.current = next?.entry.id ?? "";
          operationOwner.current.value++;
          working.current = false;
          setBusy(false);
          requests.current.clear();
          packet.current = null;
          setMessage("");
        }
        setSnapshot(next ?? null);
        setError("");
        if (next?.selection && next.entry.id !== selectionSeen.current) {
          selectionSeen.current = next.entry.id;
          setOpened(next.kind !== "link" && next.kind !== "video");
        }
      }
    } catch {
      if (alive.current && current === generation.current.value) {
        setSnapshot(null);
        setError("Clipboard actions could not be loaded.");
      }
    }
  }, [id, silent, menu]);
  useEffect(() => {
    alive.current = true;
    const readCounter = generation.current,
      actionCounter = operationOwner.current;
    let active = true;
    let stop: (() => void) | undefined;
    requests.current.clear();
    packet.current = null;
    operationOwner.current.value++;
    working.current = false;
    setBusy(false);
    setOpened(menu);
    setMessage("");
    void listen("context:changed", () => {
      if (active) void refresh();
    })
      .then((value) => {
        if (active) stop = value;
        else value();
      })
      .catch(() => {
        if (active) setError("Live clipboard context is unavailable.");
      });
    void refresh();
    return () => {
      active = false;
      alive.current = false;
      readCounter.value++;
      actionCounter.value++;
      stop?.();
    };
  }, [refresh, menu]);
  const run = async (action: () => Promise<string>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    const current = ++operationOwner.current.value;
    try {
      const text = await action();
      if (alive.current && current === operationOwner.current.value) setMessage(text);
    } catch (reason) {
      if (alive.current && current === operationOwner.current.value) setError(String(reason));
    } finally {
      if (current === operationOwner.current.value) {
        working.current = false;
        if (alive.current) setBusy(false);
      }
    }
  };
  if (silent) return null;
  if (!snapshot)
    return error ? (
      <p role="alert" className="clipboard-context-message">
        {error}{" "}
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </p>
    ) : null;
  const source = snapshot.entry;
  const requestId = (operation: string) => {
    const key = source.id + ":" + operation;
    let id = requests.current.get(key);
    if (!id) {
      id = crypto.randomUUID();
      requests.current.set(key, id);
    }
    return id;
  };
  const transform = (operation: string, paste = false) =>
    void run(async () => {
      const result = await contextApi.transform(source.id, operation, requestId(operation));
      if (paste) {
        const outcome = await clipboardApi.pick(result.id, "paste");
        if (outcome.kind === "pasteSent") pasted?.();
        return outcome.message;
      }
      return "Result copied and added to history";
    });
  const save = () =>
    void run(async () => {
      const owner = operationOwner.current.value;
      const state = await notesApi.state();
      if (!alive.current || owner !== operationOwner.current.value)
        throw new Error("Clipboard context changed before saving. Review the current item.");
      if (!packet.current || !sameScope(packet.current.expectedScope, state.scope))
        packet.current = {
          requestId: crypto.randomUUID(),
          expectedScope: state.scope,
          draft: {
            title: source.content.split(/\r?\n/)[0].slice(0, 200),
            body: source.content,
            kind: "note",
            priority: "inbox",
          },
          patch: {},
          reminders: [],
        };
      const saved = await notesApi.capture(packet.current);
      return saved.scope ? "Saved on this PC; queued for Tack" : "Saved on this PC · Notes";
    });
  const review = (toolId: string) =>
    void run(async () => {
      await contextApi.review(source.id, toolId);
      return "Review opened";
    });
  const action = (name: "save-image" | "shelf" | "pin" | "reveal") =>
    void run(() => contextApi.action(source.id, name));
  return (
    <div className="clipboard-context" data-context-kind={snapshot.kind}>
      {snapshot.selection && (
        <div className="clipboard-selection-heading">
          <span title={source.content}>Selected text · {source.preview}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await contextApi.dismiss();
                return "Selection dismissed";
              })
            }
          >
            Dismiss
          </button>
        </div>
      )}
      {(snapshot.kind === "link" || snapshot.kind === "video") && !opened ? (
        <>
          <ClipboardLinkRow entry={source} download={download} preferSave={snapshot.selection} />
          {snapshot.selection && (
            <button
              type="button"
              className="clipboard-context-text-tools"
              data-text-trigger
              onClick={() => setOpened(true)}
            >
              Text tools
            </button>
          )}
        </>
      ) : (
        <>
          {(!opened || snapshot.kind === "image" || snapshot.kind === "files") && (
            <section className="clipboard-link-context" aria-label="Clipboard context actions">
              <div className="clipboard-link-heading">
                <code>{source.preview || source.content}</code>
                <span>{formatRelativeTime(source.lastUsedAt)}</span>
              </div>
              <div className="clipboard-link-buttons">
                {(snapshot.kind === "text" || snapshot.kind === "json") && (
                  <button
                    type="button"
                    className="is-signal"
                    data-text-trigger={snapshot.kind === "text" ? "" : undefined}
                    disabled={busy}
                    onClick={() => (snapshot.kind === "json" ? transform("json") : setOpened(true))}
                  >
                    {snapshot.kind === "json" ? "Format JSON" : "Text tools"}
                  </button>
                )}
                {snapshot.kind === "json" && (
                  <button
                    type="button"
                    data-text-trigger
                    disabled={busy}
                    onClick={() => setOpened(true)}
                  >
                    Text tools
                  </button>
                )}
                {snapshot.kind === "image" && (
                  <button
                    type="button"
                    className="is-signal"
                    disabled={busy}
                    onClick={() => action("save-image")}
                  >
                    Save as file
                  </button>
                )}
                {snapshot.kind === "files" && (
                  <button
                    type="button"
                    className="is-signal"
                    disabled={busy}
                    onClick={() => action("shelf")}
                  >
                    Add to Shelf
                  </button>
                )}
                {snapshot.kind === "path" && (
                  <>
                    <button
                      type="button"
                      className="is-signal"
                      disabled={busy}
                      onClick={() => action("reveal")}
                    >
                      Reveal
                    </button>
                    <button type="button" disabled={busy} onClick={() => action("pin")}>
                      Pin
                    </button>
                  </>
                )}
                {snapshot.tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    disabled={busy}
                    onClick={() => review(tool.id)}
                  >
                    {tool.id === "image-text"
                      ? "Text"
                      : tool.id === "decode-qr"
                        ? "Decode QR"
                        : tool.id === "to-jpg"
                          ? "Convert"
                          : tool.name}
                  </button>
                ))}
              </div>
            </section>
          )}
          {opened && snapshot.kind !== "image" && snapshot.kind !== "files" && (
            <TextToolsMenu
              key={source.id}
              tools={snapshot.textTools}
              busy={busy}
              run={transform}
              paste={() => transform("plain", true)}
              qr={() => review("encode-qr")}
              save={save}
              close={() => {
                setOpened(false);
                closeMenu?.();
              }}
            />
          )}
        </>
      )}
      {message && (
        <p className="clipboard-context-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="clipboard-context-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
