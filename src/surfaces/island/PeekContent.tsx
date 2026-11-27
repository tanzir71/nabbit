import { FocusTimer } from "../../features/timer/FocusTimer";
import { MediaPlayer } from "../../features/media/MediaPlayer";
import type { ActivityItem } from "../../lib/activity";
import { activityTitle, basename, duration, percent } from "../../lib/islandPresentation";
import { PresetChip } from "../../components/PresetChip";
import { IconButton } from "../../components/IconButton";
import { IslandAsset } from "./IslandAsset";
import { MiniButton, type IslandIntent } from "./CompactContent";
import { usePreset } from "../../features/downloads/usePreset";
import { defaultDownloadPresets } from "../../lib/downloadPresets";
function OtherPeekContent({
  item,
  act,
}: {
  item: ActivityItem;
  act: (intent: IslandIntent) => void;
}) {
  const e = item.event,
    invoke = (action: string) => act({ action, item });
  const choice = usePreset(e.kind === "linkDetected" ? e.url : "");
  const primaryPreset =
    choice.preset.id === "mp3_320" ? defaultDownloadPresets()[0] : choice.preset;
  const [primaryLabel, primaryMeta] =
    primaryPreset.id === "custom"
      ? ["Custom", primaryPreset.options.format?.toUpperCase()]
      : primaryPreset.label.replace("…", "").split(" · ");
  const control = (name: string, label: string, action: string) => (
    <IconButton variant="island" size={28} label={label} onClick={() => invoke(action)}>
      <IslandAsset group="peek" name={name} />
    </IconButton>
  );
  return (
    <div className="island-peek-content">
      <div className="island-row island-peek-header">
        {(e.kind === "linkDetected" || e.kind === "downloadProgress") && (
          <div className="island-thumbnail" />
        )}
        {e.kind === "mediaChanged" && (
          <div
            className="island-artwork is-peek"
            style={e.art ? { backgroundImage: `url(${JSON.stringify(e.art)})` } : undefined}
          />
        )}
        {e.kind === "timerTick" && <IslandAsset group="peek" name="iconTimer" />}
        {e.kind === "downloadDone" && <IslandAsset group="peek" name="iconCircleCheck" />}
        <div className="island-text-stack island-spacer">
          <strong className="island-ellipsis">
            {e.kind === "downloadDone" ? "Saved to Downloads" : activityTitle(item)}
          </strong>
          <span className={`island-muted${e.kind === "downloadProgress" ? " island-mono" : ""}`}>
            {e.kind === "downloadProgress"
              ? [e.speed, e.eta && `${e.eta} left`].filter(Boolean).join(" · ")
              : e.kind === "linkDetected"
                ? [e.site, e.duration != null && duration(e.duration)].filter(Boolean).join(" · ")
                : e.kind === "mediaChanged"
                  ? e.artist
                  : e.kind === "timerTick"
                    ? "Focus session"
                    : ""}
          </span>
        </div>
        {e.kind === "downloadProgress" && (
          <>
            {control("iconPause", "Pause download", "pause")}
            {control("iconX", "Cancel download", "cancel")}
          </>
        )}
        {e.kind === "mediaChanged" && (
          <>
            {control("iconSkipBack", "Previous track", "previous")}
            {control("iconPause1", e.playing ? "Pause playback" : "Play", "playPause")}
            {control("iconSkipForward", "Next track", "next")}
          </>
        )}
        {e.kind === "timerTick" && (
          <>
            <span className="island-timer-value">{duration(e.remainingS)}</span>
            {control("iconPause", "Pause timer", "pauseTimer")}
            {control("iconSquare", "Stop timer", "stopTimer")}
          </>
        )}
      </div>
      {e.kind === "linkDetected" && (
        <div className="island-row">
          <PresetChip
            surface="island"
            selected={choice.preset.id !== "mp3_320"}
            disabled={!choice.ready}
            onClick={() => choice.choose(primaryPreset)}
          >
            {primaryLabel}
            {primaryMeta && <span className="island-mono">{primaryMeta}</span>}
          </PresetChip>
          <PresetChip
            surface="island"
            selected={choice.preset.id === "mp3_320"}
            disabled={!choice.ready}
            onClick={() => choice.choose(defaultDownloadPresets()[2])}
          >
            MP3<span className="island-mono">320</span>
          </PresetChip>
          <PresetChip
            surface="island"
            onClick={() => act({ action: "review", item, preset: choice.preset })}
          >
            More
          </PresetChip>
          <span className="island-spacer" />
          <MiniButton
            signal
            onClick={() => {
              if (choice.ready) act({ action: "nab", item, options: choice.preset.options });
            }}
          >
            <IslandAsset group="peek" name="iconDownload" />
            Nab it
          </MiniButton>
        </div>
      )}
      {(e.kind === "downloadProgress" || e.kind === "timerTick") && (
        <div className="island-progress">
          <i
            style={{
              width: `${e.kind === "downloadProgress" ? percent(e.percent) : Math.min(100, e.remainingS / 15)}%`,
            }}
          />
        </div>
      )}
      {e.kind === "mediaChanged" && e.timeline && (
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
      {e.kind === "downloadDone" && (
        <>
          <div className="island-result-name">{basename(e.path)}</div>
          <div className="island-row">
            <MiniButton signal onClick={() => invoke("fileReview")}>
              To MP4
            </MiniButton>
            <MiniButton onClick={() => invoke("reveal")}>Reveal</MiniButton>
            <MiniButton onClick={() => invoke("fileReview")}>Move to…</MiniButton>
          </div>
        </>
      )}
      {!["linkDetected", "downloadProgress", "mediaChanged", "timerTick", "downloadDone"].includes(
        e.kind,
      ) && <MiniButton onClick={() => invoke("review")}>Open details</MiniButton>}
    </div>
  );
}

export function PeekContent(props: { item: ActivityItem; act: (intent: IslandIntent) => void }) {
  if (props.item.event.kind === "privacyChanged") {
    const { mic, camera } = props.item.event;
    return (
      <section className="island-peek-content" aria-label="Mic and camera activity">
        <h1 className="island-sr-only">Mic and camera activity</h1>
        <div className="island-row island-peek-header">
          <IslandAsset name="iconMic" />
          <div className="island-text-stack island-spacer">
            <strong>
              {mic.length && camera.length
                ? "Microphone and camera in use"
                : camera.length
                  ? "Camera in use"
                  : "Microphone in use"}
            </strong>
            {mic.length > 0 && (
              <span className="island-muted" title={mic.join(", ")}>
                Microphone · {mic.join(", ")}
              </span>
            )}
            {camera.length > 0 && (
              <span className="island-muted" title={camera.join(", ")}>
                Camera · {camera.join(", ")}
              </span>
            )}
          </div>
        </div>
      </section>
    );
  }
  if (["timerTick", "timerPaused", "timerEnded"].includes(props.item.event.kind))
    return <FocusTimer peek />;
  return props.item.event.kind === "mediaChanged" ? (
    <MediaPlayer peek />
  ) : (
    <OtherPeekContent {...props} />
  );
}
