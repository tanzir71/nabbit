import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IslandNab } from "../../features/downloads/IslandNab";
import { PresetChip } from "../../components/PresetChip";
import { ProgressRing } from "../../components/ProgressRing";
import { basename, duration, percent } from "../../lib/islandPresentation";
import type { ActivityItem } from "../../lib/activity";
import type { ClipboardEntry } from "../../lib/types";
import type { IslandAction, IslandModel } from "../../store/islandStore";
import { MiniButton, type IslandIntent } from "./CompactContent";
import { IslandNotesSync } from "../../features/notes/IslandNotesSync";
interface Props {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
  act: (intent: IslandIntent) => void;
}
const itemsOf = (model: IslandModel) =>
  [model.primary, model.bubble, ...model.queue].filter(
    (item): item is ActivityItem => item !== null,
  );

function Clipboard({ model, dispatch, act }: Props) {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      stop: (() => void) | undefined;
    const refresh = () => {
      void invoke<ClipboardEntry[]>("list_clipboard_entries", { query: null })
        .then((data) => {
          if (active) setEntries(data);
        })
        .catch((reason) => {
          if (active) setError(String(reason));
        });
    };
    void listen("clipboard:new", refresh)
      .then((unlisten) => {
        if (active) {
          stop = unlisten;
          refresh();
        } else unlisten();
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  const filter = model.filters.clipboard || "All",
    query = model.filters.clipboardQuery || "";
  const filtered = entries.filter(
    (entry) =>
      (filter === "All" ||
        (filter === "Pinned" && entry.pinned) ||
        entry.contentType ===
          (
            { Text: "text", Links: "url", Images: "image", Files: "file" } as Record<string, string>
          )[filter]) &&
      `${entry.content} ${entry.preview}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="island-module-body">
      <div className="island-row">
        <input
          aria-label="Search clipboard"
          className="island-clipboard-search"
          placeholder="Search clipboard"
          value={query}
          onChange={(e) =>
            dispatch({ type: "filter", name: "clipboardQuery", value: e.target.value })
          }
        />
        {["All", "Text", "Links", "Images", "Files", "Pinned"].map((name) => (
          <PresetChip
            key={name}
            surface="island"
            selected={filter === name}
            onClick={() => dispatch({ type: "filter", name: "clipboard", value: name })}
          >
            {name}
          </PresetChip>
        ))}
      </div>
      <div className="island-clipboard-rows">
        {filtered.map((entry) => (
          <div key={entry.id} className="island-row">
            <button
              className="island-clipboard-copy island-spacer"
              onClick={() => {
                void invoke("copy_clipboard_entry", { id: entry.id }).catch((reason) =>
                  setError(String(reason)),
                );
              }}
            >
              <span>{entry.preview || entry.content}</span>
              <small className="island-muted">{entry.sourceApp || entry.contentType}</small>
            </button>
            {entry.contentType === "url" && (
              <MiniButton
                signal
                onClick={() => {
                  void invoke("island_review_url", { url: entry.content })
                    .then(() => dispatch({ type: "tab", tab: "nab" }))
                    .catch((reason) => setError(String(reason)));
                }}
              >
                Nab
              </MiniButton>
            )}
          </div>
        ))}
      </div>
      {!filtered.length && <p className="island-empty">No clipboard items</p>}
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
      <div className="island-row island-muted">
        <span className="island-spacer">{entries.length} items</span>
        <MiniButton onClick={() => act({ action: "tray" })}>All clipboard</MiniButton>
      </div>
    </div>
  );
}
export default function ModuleBody(props: Props) {
  const { model, act } = props;
  if (model.tab === "nab") return <IslandNab model={model} dispatch={props.dispatch} />;
  if (model.tab === "clipboard") return <Clipboard {...props} />;
  const current = itemsOf(model).find((item) =>
    model.tab === "media"
      ? item.category === "media"
      : model.tab === "timer"
        ? ["timer", "timerEnding"].includes(item.category)
        : false,
  );
  if (model.tab === "media" && current?.event.kind === "mediaChanged") {
    const e = current.event;
    return (
      <div className="island-module-body">
        <div className="island-media-body">
          <div
            className="island-artwork is-expanded"
            style={e.art ? { backgroundImage: `url(${JSON.stringify(e.art)})` } : undefined}
          />
          <div className="island-spacer island-text-stack">
            <h2>{e.title}</h2>
            <p className="island-muted">{e.artist}</p>
            {e.timeline && (
              <div className="island-row island-mono island-muted">
                <span>{duration(e.timeline.positionS)}</span>
                <div className="island-progress is-media">
                  <i
                    style={{
                      width: `${percent((e.timeline.positionS / Math.max(1, e.timeline.durationS)) * 100)}%`,
                    }}
                  />
                </div>
                <span>{duration(e.timeline.durationS)}</span>
              </div>
            )}
            <p className="island-muted">{e.playing ? "Playing" : "Paused"}</p>
          </div>
        </div>
      </div>
    );
  }
  if (model.tab === "timer" && current?.event.kind === "timerTick") {
    const e = current.event;
    return (
      <div className="island-timer-body">
        <div className="island-clock">
          <ProgressRing value={Math.min(100, e.remainingS / 15)} label="Focus timer" size={120} />
          <span>{duration(e.remainingS)}</span>
        </div>
        <div className="island-text-stack">
          <h2>{e.label || "Focus"}</h2>
          <p className="island-muted">Focus session</p>
        </div>
      </div>
    );
  }
  const empty = {
    notes: ["No notes yet", "Keep your thoughts close."],
    files: ["Your shelf is empty", "Files in transit will appear here."],
    media: ["Nothing playing", "Your active media appears here."],
    timer: ["No focus session", "Your focus session appears here."],
  }[model.tab];
  return (
    <>
      <DraftBody
        model={model}
        fallback={
          <div className="island-module-body">
            <div className="island-empty">
              <h2>{empty?.[0]}</h2>
              <p className="island-muted">{empty?.[1]}</p>
            </div>
            <MiniButton onClick={() => act({ action: "tray" })}>Open Nabbit</MiniButton>
          </div>
        }
      />
      {model.tab === "notes" ? <IslandNotesSync open={() => act({ action: "tray" })} /> : null}
    </>
  );
}
function DraftBody({ model, fallback }: { model: IslandModel; fallback: React.ReactNode }) {
  const [draft, setDraft] = useState<{
      zone: string;
      payload: { url?: string; text?: string; files?: string[] };
    } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void invoke<typeof draft>("get_island_drop")
      .then((value) => {
        if (active) setDraft(value);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [model.tab]);
  if (error)
    return (
      <p className="island-error" role="alert">
        {error}
      </p>
    );
  const matches =
    draft &&
    ((draft.zone === "note" && model.tab === "notes") ||
      (draft.zone === "shelf" && model.tab === "files"));
  return matches ? (
    <section className="island-module-body">
      <h2>{draft.zone === "note" ? "New note" : "Files ready to add"}</h2>
      {(draft.payload.text || draft.payload.url) && (
        <p className="island-draft-text">{draft.payload.text || draft.payload.url}</p>
      )}
      {draft.payload.files?.map((path) => (
        <div key={path} className="island-result-name">
          {basename(path)}
        </div>
      ))}
    </section>
  ) : (
    fallback
  );
}
