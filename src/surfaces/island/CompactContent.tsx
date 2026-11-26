import type { ActivityItem } from "../../lib/activity";
import {
  activityTitle,
  basename,
  bytes,
  compactKind,
  duration,
  percent,
} from "../../lib/islandPresentation";
import { ProgressRing } from "../../components/ProgressRing";
import { Button } from "../../components/Button";
import { IslandAsset } from "./IslandAsset";
export type IslandIntent = {
  action: string;
  item?: ActivityItem;
  options?: import("../../lib/types").DownloadOptions;
  preset?: import("../../lib/types").DownloadPreset;
};
export function MiniButton({
  children,
  signal,
  onClick,
}: {
  children: React.ReactNode;
  signal?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className={`island-mini${signal ? " is-signal" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </Button>
  );
}
export function CompactContent({
  item,
  act,
}: {
  item: ActivityItem | null;
  act: (intent: IslandIntent) => void;
}) {
  if (!item) return null;
  const e = item.event,
    kind = compactKind(item),
    invoke = (action: string) => act({ action, item });
  const icon = (name: string) => <IslandAsset name={name} />;
  const button = (label: string, action: string, signal = false) => (
    <MiniButton signal={signal} onClick={() => invoke(action)}>
      {label}
    </MiniButton>
  );
  switch (e.kind) {
    case "volumeChanged":
      return (
        <>
          <IslandAsset name="iconVolume2" />
          <div className="island-progress is-media">
            <i style={{ width: `${e.muted ? 0 : percent(e.percent)}%` }} />
          </div>
          <span className="island-mono island-muted">{percent(e.percent)}</span>
        </>
      );
    case "downloadProgress":
    case "toolJob":
      return (
        <>
          <ProgressRing value={e.percent} size={18} label="Progress" />
          <span className="island-ellipsis island-muted">{activityTitle(item)}</span>
          <span className="island-mono">{percent(e.percent)}%</span>
        </>
      );
    case "linkDetected":
      return (
        <>
          {icon("iconLink")}
          <strong className="island-link-label" title={e.title || e.site}>
            {e.title ? "Video link copied" : e.site}
          </strong>
          {e.duration != null && (
            <span className="island-mono island-muted">{duration(e.duration)}</span>
          )}
          <span className="island-spacer" />
          <MiniButton signal onClick={() => invoke("nab")}>
            {icon("iconDownload")}Nab it
          </MiniButton>
        </>
      );
    case "mediaChanged":
      return (
        <>
          <span
            className="island-artwork"
            style={e.art ? { backgroundImage: `url(${JSON.stringify(e.art)})` } : undefined}
          />
          <span className="island-spacer" />
          <span className="island-bars" aria-label={e.playing ? "Playing" : "Paused"}>
            {[6, 12, 8, 14, 5].map((height, i) => (
              <i key={i} style={{ height: e.playing ? height : 3 }} />
            ))}
          </span>
        </>
      );
    case "timerTick":
    case "timerEnded":
      return (
        <>
          {icon("iconTimer")}
          <span className="island-ellipsis island-muted">
            {e.kind === "timerTick" ? e.label || "Focus" : "Time is up"}
          </span>
          <span className="island-mono">{duration(e.kind === "timerTick" ? e.remainingS : 0)}</span>
        </>
      );
    case "privacyChanged":
      return (
        <>
          {icon("iconMic")}
          <span className="island-ellipsis island-muted">{activityTitle(item)}</span>
          {icon("privacyDot")}
        </>
      );
    case "powerChanged":
      return (
        <>
          {icon("iconBatteryCharging")}
          <span className="island-muted">{e.charging ? "Charging" : "Battery low"}</span>
          <span className="island-spacer" />
          <span className="island-mono">{e.percent}%</span>
        </>
      );
    case "downloadDone":
      return (
        <>
          {icon("iconCircleCheck")}
          <strong>Saved</strong>
          <span className="island-ellipsis island-muted">{basename(e.path)}</span>
          {button("Open", "open")}
        </>
      );
    case "downloadFailed":
      return (
        <>
          {icon("iconTriangleAlert")}
          <span className="island-ellipsis">
            {e.jobId === "engine-health"
              ? "Download engine needs an update"
              : "Download needs attention"}
          </span>
          <MiniButton onClick={() => invoke("review")}>{icon("iconWrench")}Fix</MiniButton>
        </>
      );
    case "noteSaved":
    case "linkSaved":
      return (
        <>
          {icon("iconStickyNote")}
          <span className="island-ellipsis">
            {e.kind === "noteSaved" ? `Saved to ${e.destination}` : `Saved ${e.title}`}
          </span>
          {icon("iconCheck")}
        </>
      );
    case "filesMoved":
      return (
        <>
          {icon("iconFolderInput")}
          <strong className="island-ellipsis">{activityTitle(item)}</strong>
          <span className="island-mono island-muted">
            {e.count} {e.count === 1 ? "file" : "files"}
          </span>
          {e.undoable && button("Undo", "undo")}
        </>
      );
    case "toolResult":
      return (
        <>
          {icon("iconFileVideo")}
          <span className="island-mono island-ellipsis">
            {basename(e.path)} {bytes(e.beforeBytes)} → {bytes(e.afterBytes)}
          </span>
          <span className="island-muted">{e.note}</span>
          {icon("iconCheck1")}
        </>
      );
    default:
      return <span className={`island-ellipsis island-${kind}`}>{activityTitle(item)}</span>;
  }
}
export function BubbleContent({ item }: { item: ActivityItem }) {
  const kind = compactKind(item);
  if (kind === "download" || kind === "tool")
    return (
      <ProgressRing
        value={"percent" in item.event ? item.event.percent : 0}
        size={18}
        label={activityTitle(item)}
      />
    );
  const names: Partial<Record<typeof kind, string>> = {
    volume: "iconVolume2",
    timer: "iconTimer1",
    privacy: "iconMic",
    link: "iconLink",
    media: "iconVolume2",
    power: "iconBatteryCharging",
    done: "iconCircleCheck",
    error: "iconTriangleAlert",
    note: "iconStickyNote",
    moved: "iconFolderInput",
    result: "iconFileVideo",
  };
  return <IslandAsset name={names[kind] ?? "iconTimer1"} />;
}
