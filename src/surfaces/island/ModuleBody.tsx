import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IslandNab } from "../../features/downloads/IslandNab";
import { ProgressRing } from "../../components/ProgressRing";
import { basename, duration, percent } from "../../lib/islandPresentation";
import type { ActivityItem } from "../../lib/activity";
import type { IslandAction, IslandModel } from "../../store/islandStore";
import { MiniButton, type IslandIntent } from "./CompactContent";
import { IslandNotes } from "../../features/notes/IslandNotes";
import { IslandClipboard } from "../../features/clipboard/IslandClipboard";
interface Props {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
  act: (intent: IslandIntent) => void;
}
const itemsOf = (model: IslandModel) =>
  [model.primary, model.bubble, ...model.queue].filter(
    (item): item is ActivityItem => item !== null,
  );

export default function ModuleBody(props: Props) {
  const { model, act } = props;
  if (model.tab === "nab") return <IslandNab model={model} dispatch={props.dispatch} />;
  if (model.tab === "clipboard") return <IslandClipboard model={model} dispatch={props.dispatch} />;
  if (model.tab === "notes")
    return (
      <>
        <DraftBody model={model} fallback={null} />
        <IslandNotes model={model} dispatch={props.dispatch} />
      </>
    );
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
