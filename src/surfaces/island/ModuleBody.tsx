import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IslandNab } from "../../features/downloads/IslandNab";
import { FocusTimer } from "../../features/timer/FocusTimer";
import { basename } from "../../lib/islandPresentation";
import type { IslandAction, IslandModel } from "../../store/islandStore";
import { MiniButton, type IslandIntent } from "./CompactContent";
import { IslandNotes } from "../../features/notes/IslandNotes";
import { IslandClipboard } from "../../features/clipboard/IslandClipboard";
import { MediaPlayer } from "../../features/media/MediaPlayer";
import { IslandShelf } from "../../features/shelf/IslandShelf";
import { ToolQueue } from "../../features/tools/ToolQueue";
interface Props {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
  act: (intent: IslandIntent) => void;
}
export default function ModuleBody(props: Props) {
  const { model, act } = props;
  if (model.tab === "nab") return <IslandNab model={model} dispatch={props.dispatch} />;
  if (model.tab === "clipboard") return <IslandClipboard model={model} dispatch={props.dispatch} />;
  if (model.tab === "timer") return <FocusTimer />;
  if (model.tab === "media") return <MediaPlayer />;
  if (model.tab === "files")
    return (
      <>
        <IslandShelf model={model} dispatch={props.dispatch} />
        <ToolQueue />
      </>
    );
  if (model.tab === "notes")
    return (
      <>
        <DraftBody model={model} fallback={null} />
        <IslandNotes model={model} dispatch={props.dispatch} />
      </>
    );
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
