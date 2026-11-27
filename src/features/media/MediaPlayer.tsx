import { useState } from "react";
import { Play } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { PresetChip } from "../../components/PresetChip";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { duration } from "../../lib/islandPresentation";
import { mediaApi, type MediaAction, type MediaSession } from "./api";
import { useMedia } from "./useMedia";
import "./media.css";

function Artwork({ session, peek = false }: { session: MediaSession; peek?: boolean }) {
  return (
    <div
      className={`island-artwork ${peek ? "is-peek" : "media-art"}`}
      style={session.art ? { backgroundImage: `url(${JSON.stringify(session.art)})` } : undefined}
    />
  );
}
function Timeline({
  session,
  seek,
  action,
}: {
  session: MediaSession;
  seek: boolean;
  action: (a: MediaAction) => void;
}) {
  const t = session.timeline;
  if (!t) return null;
  return (
    <div className="media-timeline island-mono island-muted" data-media-timeline>
      <span>{duration(t.positionS)}</span>
      {seek && session.controls.seek ? (
        <input
          aria-label="Playback position"
          type="range"
          min={0}
          max={t.durationS}
          step={1}
          value={t.positionS}
          onChange={(e) =>
            action({ kind: "seek", id: session.id, positionS: e.currentTarget.valueAsNumber })
          }
          style={
            {
              "--media-progress": `${Math.min(100, (t.positionS / t.durationS) * 100)}%`,
            } as React.CSSProperties
          }
        />
      ) : (
        <div className="island-progress is-media">
          <i style={{ width: `${Math.min(100, (t.positionS / t.durationS) * 100)}%` }} />
        </div>
      )}
      <span>{duration(t.durationS)}</span>
    </div>
  );
}
function Controls({
  session,
  peek,
  action,
}: {
  session: MediaSession;
  peek: boolean;
  action: (a: MediaAction) => void;
}) {
  const canToggle =
    session.controls.toggle || (session.playing ? session.controls.pause : session.controls.play);
  const group = peek ? "peek" : "10:341";
  return (
    <div className={`media-controls${peek ? " is-peek" : ""}`}>
      <IconButton
        variant="island"
        size={28}
        className="media-skip"
        label="Previous track"
        disabled={!session.controls.previous}
        onClick={() => action({ kind: "previous", id: session.id })}
      >
        <IslandAsset group={group} name="iconSkipBack" />
      </IconButton>
      <IconButton
        variant="island"
        size={28}
        className="media-toggle"
        label={session.playing ? "Pause playback" : "Play playback"}
        disabled={!canToggle}
        onClick={() => action({ kind: "toggle", id: session.id })}
      >
        {session.playing ? (
          <IslandAsset group={group} name={peek ? "iconPause1" : "iconPause"} />
        ) : (
          <Play
            size={peek ? 16 : 20}
            style={{ width: peek ? 16 : 20, height: peek ? 16 : 20 }}
            aria-hidden="true"
          />
        )}
      </IconButton>
      <IconButton
        variant="island"
        size={28}
        className="media-skip"
        label="Next track"
        disabled={!session.controls.next}
        onClick={() => action({ kind: "next", id: session.id })}
      >
        <IslandAsset group={group} name="iconSkipForward" />
      </IconButton>
    </div>
  );
}
export function MediaPlayer({ peek = false }: { peek?: boolean }) {
  const { snapshot, session, error } = useMedia();
  const [actionError, setActionError] = useState("");
  const action = (value: MediaAction) => {
    setActionError("");
    void mediaApi.action(value).catch((e) => setActionError(String(e)));
  };
  const message = actionError || error || snapshot?.error;
  if (!session)
    return (
      <div className="island-module-body">
        <h1 className="island-sr-only">Now playing</h1>
        <div className="island-empty">
          <h2>{snapshot ? "Nothing playing" : "Loading media…"}</h2>
          <p className="island-muted">{message || "Your active media appears here."}</p>
        </div>
      </div>
    );
  const titles = (
    <div className="media-titles">
      <strong className="island-ellipsis">{session.title || "Untitled media"}</strong>
      <span className="island-muted island-ellipsis">
        {[session.artist, session.app].filter(Boolean).join(" · ")}
      </span>
    </div>
  );
  if (peek)
    return (
      <div className="island-peek-content media-peek">
        <h1 className="island-sr-only">Now playing</h1>
        <div className="island-row island-peek-header">
          <Artwork session={session} peek />
          {titles}
          <Controls session={session} peek action={action} />
        </div>
        <Timeline session={session} seek={false} action={action} />
        {message && (
          <p className="island-error" role="alert">
            {message}
          </p>
        )}
      </div>
    );
  const volume = snapshot?.volume;
  return (
    <section className="media-body" aria-label="Now playing">
      <h1 className="island-sr-only">Now playing</h1>
      <div className="media-player">
        <Artwork session={session} />
        <div className="media-info">
          {titles}
          <Timeline session={session} seek action={action} />
          <div className="media-actions">
            <Controls session={session} peek={false} action={action} />
            <span className="island-spacer" />
            <button
              type="button"
              className="media-volume-icon"
              aria-label={volume?.muted ? "Unmute" : "Mute"}
              aria-pressed={volume?.muted ?? false}
              disabled={!volume}
              onClick={() => volume && action({ kind: "mute", muted: !volume.muted })}
            >
              <IslandAsset group="10:341" name="iconVolume2" />
            </button>
            <input
              type="range"
              aria-label="System volume"
              min={0}
              max={100}
              value={volume?.percent ?? 0}
              disabled={!volume}
              onChange={(e) => action({ kind: "volume", percent: e.currentTarget.valueAsNumber })}
              style={
                {
                  "--media-progress": `${volume?.muted ? 0 : (volume?.percent ?? 0)}%`,
                } as React.CSSProperties
              }
            />
            <span className="media-output" title="Default system output">
              <IslandAsset group="10:341" name="iconMonitor" />
            </span>
          </div>
        </div>
      </div>
      <div className="media-sessions">
        <span className="island-muted">Sessions</span>
        <div className="media-session-chips">
          {snapshot?.sessions.map((s) => (
            <PresetChip
              key={s.id}
              surface="island"
              selected={s.id === session.id}
              onClick={() => {
                setActionError("");
                void mediaApi.select(s.id).catch((e) => setActionError(String(e)));
              }}
            >
              {s.app || "Media player"}
            </PresetChip>
          ))}
        </div>
        <span className="media-hint island-muted">Scroll on the pill to change volume</span>
      </div>
      {message && (
        <p className="island-error" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
