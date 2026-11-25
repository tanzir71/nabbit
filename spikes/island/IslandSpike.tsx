import { useEffect, useRef, useState, type DragEvent } from "react";
import { flushSync } from "react-dom";
import { Button } from "../../src/components/Button";
import { IconButton } from "../../src/components/IconButton";
import { assets } from "./assets";
import { connectInteraction, type HitRect, type NativeReport, type Presentation } from "./bridge";
import { connectNativeSurface, type SurfaceState } from "./native-surface";
import {
  classify,
  readDrag,
  routeDrop,
  zoneOrder,
  type Payload,
  type PayloadKind,
  type DropZone,
  type Receipt,
} from "./drop";

const states = ["idle", "live", "peek", "expanded"] as const;
type SpikeState = (typeof states)[number];
declare global {
  interface Window {
    nabbitIslandSpike?: {
      setState: (state: SpikeState) => void;
      receiveInteraction: (value: Presentation) => void;
      nativeSnapshot: (refresh?: boolean) => Promise<NativeReport>;
      hitrect: () => HitRect | null;
      receivedFiles: () => string[];
      ready: true;
    };
  }
}

const title = "Tiny tray app in Rust, full walkthrough";
const query = new URLSearchParams(location.search);

function Icon({ asset }: { asset: string }) {
  return <img src={asset} alt="" draggable={false} />;
}

function PreviewIcon({
  label,
  asset,
  className = "",
}: {
  label: string;
  asset: string;
  className?: string;
}) {
  return (
    <IconButton label={`${label} (visual spike)`} disabled className={`spike-icon ${className}`}>
      <Icon asset={asset} />
    </IconButton>
  );
}

function Expanded() {
  return (
    <div className="expanded-content">
      <div className="spike-tabs" aria-label="Module previews">
        <Button disabled className="spike-button spike-tab">
          <Icon asset={assets.download} />
          Nab
        </Button>
        {(
          [
            ["Notes", assets.stickyNote],
            ["Clipboard", assets.clipboardList],
            ["Files", assets.folder],
            ["Media", assets.audioLines],
            ["Timer", assets.timer],
          ] as const
        ).map(([label, asset]) => (
          <PreviewIcon key={label} label={label} asset={asset} />
        ))}
        <span className="spacer" />
        <PreviewIcon label="Search" asset={assets.search} />
        <PreviewIcon label="Tray" asset={assets.panelTop} />
        <PreviewIcon label="Settings" asset={assets.settings} />
      </div>
      <div className="spike-review">
        <div className="thumbnail review-thumbnail">
          <span className="duration mono">12:48</span>
        </div>
        <div className="review-details">
          <strong>{title}</strong>
          <p className="muted">Ferris Builds · youtube.com · about 420 MB</p>
          <div className="presets">
            {[
              ["MP4", "1080p"],
              ["MP4", "720p"],
              ["MP3", "320"],
              ["M4A", ""],
              ["Custom", ""],
            ].map(([name, meta], index) => (
              <Button
                key={index}
                disabled
                className={`spike-button preset ${index === 0 ? "selected" : ""}`}
              >
                {name}
                {meta && <span className="mono">{meta}</span>}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div className="spike-actions">
        <Button disabled className="spike-button">
          <Icon asset={assets.scissors} />
          Trim · full
        </Button>
        <Button disabled className="spike-button">
          <Icon asset={assets.captions} />
          Subtitles off
        </Button>
        <Button disabled className="spike-button">
          <Icon asset={assets.ellipsis} />
          More
        </Button>
        <span className="spacer" />
        <span className="muted destination">Saves to Downloads\Nabbit</span>
        <Button disabled className="spike-button primary">
          <Icon asset={assets.download1} />
          Nab it <kbd>Enter</kbd>
        </Button>
      </div>
      <div className="divider" />
      <div className="spike-queue">
        <div className="queue-row">
          <Icon asset={assets.progressRing} />
          <span className="queue-title">Lofi beats to code to (2 hour mix)</span>
          <span className="mono muted">62% · 3.1 MB/s · MP3 320</span>
          <PreviewIcon label="Pause queue item" asset={assets.pause} className="queue-icon" />
        </div>
        <div className="queue-row">
          <Icon asset={assets.progressRing1} />
          <span className="queue-title">Creative Commons short films, playlist 1–5</span>
          <span className="mono muted">Queued · 5 items · MP4 720p</span>
          <PreviewIcon label="More queue actions" asset={assets.ellipsis1} className="queue-icon" />
        </div>
      </div>
    </div>
  );
}

export function IslandSpike() {
  const pill = useRef<HTMLDivElement>(null);
  const bridge = useRef<ReturnType<typeof connectInteraction> | null>(null);
  const [interaction, setInteraction] = useState<Presentation>({
    hidden: false,
    dragging: false,
    revision: -1,
  });
  const [payloadKind, setPayloadKind] = useState<PayloadKind>("link");
  const [over, setOver] = useState<DropZone | undefined>();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [surface, setSurface] = useState<{ state: SurfaceState; motion: string }>({
    state: window.__NABBIT_NATIVE_START__ ?? "idle",
    motion: "live",
  });
  useEffect(() => {
    const receiveInteraction = (value: Presentation) =>
      setInteraction((previous) => {
        if (
          value.revision < previous.revision ||
          (value.revision === previous.revision &&
            value.hidden === previous.hidden &&
            value.dragging === previous.dragging)
        )
          return previous;
        return value;
      });
    const incoming = (payload: Payload, zone?: DropZone) => {
      setReceipt(routeDrop(payload, zone));
      bridge.current?.setDrag(false);
    };
    const current = connectInteraction(pill.current!, receiveInteraction, incoming, (payload) =>
      setPayloadKind(classify(payload, true)),
    );
    bridge.current = current;
    const renderState = (next: SurfaceState) => {
      const rank = { idle: 0, live: 1, peek: 2, expanded: 3, drop: 2 };
      flushSync(() =>
        setSurface((previous) => ({
          state: next,
          motion: rank[next] < rank[previous.state] ? "collapse" : next === "drop" ? "peek" : next,
        })),
      );
    };
    const native = connectNativeSurface(pill.current!, current.ready, renderState);
    const setState = (next: SpikeState) => {
      if (!states.includes(next)) throw new Error(`Invalid spike state: ${String(next)}`);
      if (window.__NABBIT_NATIVE_COMPACT__) void native.setState(next);
      else renderState(next);
    };
    window.nabbitIslandSpike = {
      ready: true,
      setState,
      receiveInteraction,
      nativeSnapshot: current.snapshot,
      hitrect: current.rect,
      receivedFiles: current.receivedFiles,
    };
    return () => {
      current.close();
      native.close();
      bridge.current = null;
      delete window.nabbitIslandSpike;
    };
  }, []);
  const dropZone = (target: EventTarget) =>
    target instanceof Element
      ? (target.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone as DropZone | undefined)
      : undefined;
  const drag = (event: DragEvent) => {
    event.preventDefault();
    setReceipt(null);
    const kind = classify(readDrag(event.dataTransfer), true);
    setPayloadKind(kind);
    setOver(dropZone(event.target));
    bridge.current?.setDrag(true);
    // Preview has no backend. Native visibility remains solely Rust-driven.
    if (!("__TAURI_INTERNALS__" in window))
      setInteraction((previous) => ({ ...previous, dragging: true }));
  };
  const leave = (event: DragEvent) => {
    if (event.clientX >= 32 && event.clientX <= 688 && event.clientY >= 0 && event.clientY <= 164)
      return;
    bridge.current?.setDrag(false);
    if (!("__TAURI_INTERNALS__" in window))
      setInteraction((previous) => ({ ...previous, dragging: false }));
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    if (bridge.current?.files(event.dataTransfer, event.clientX, event.clientY)) return;
    setReceipt(routeDrop(readDrag(event.dataTransfer), dropZone(event.target)));
    bridge.current?.setDrag(false);
    if (!("__TAURI_INTERNALS__" in window))
      setInteraction((previous) => ({ ...previous, dragging: false }));
  };
  const state = !window.__NABBIT_NATIVE_COMPACT__ && interaction.dragging ? "drop" : surface.state;
  const selectedZone = over ?? zoneOrder(payloadKind)[0];
  const dropIcons = {
    download: {
      download: assets.dropArrowDownToLine,
      shelf: assets.dropInbox,
      note: assets.dropStickyNote,
    },
    shelf: {
      download: assets.dropShelfArrowDownToLine,
      shelf: assets.dropShelfInbox,
      note: assets.dropShelfStickyNote,
    },
    note: {
      download: assets.dropNoteArrowDownToLine,
      shelf: assets.dropNoteInbox,
      note: assets.dropNoteStickyNote,
    },
  };
  const zones = {
    download: { label: "Download", hint: "Links and playlists" },
    shelf: { label: "Add to shelf", hint: "Hold files for later" },
    note: { label: "New note", hint: "Text, links, images" },
  };
  return (
    <main
      className="spike-frame"
      data-hidden={interaction.hidden}
      aria-hidden={interaction.hidden}
      aria-label="Island geometry and motion spike"
      onDragEnter={drag}
      onDragOver={drag}
      onDragLeave={leave}
      onDrop={drop}
    >
      <div
        ref={pill}
        className="spike-pill"
        data-state={state}
        data-motion={interaction.dragging ? "peek" : surface.motion}
      >
        <div
          className={`spike-layer live-content ${state === "live" ? "active" : ""}`}
          aria-hidden={state !== "live"}
        >
          <Icon asset={assets.liveRing} />
          <span className="live-title muted" title={title}>
            {title}
          </span>
          <span className="mono">38%</span>
        </div>
        <div
          className={`spike-layer peek-content ${state === "peek" ? "active" : ""}`}
          aria-hidden={state !== "peek"}
        >
          <div className="peek-header">
            <div className="thumbnail peek-thumbnail" />
            <div className="peek-text">
              <p title={title}>{title}</p>
              <p className="mono muted">4.2 MB/s · 1:12 left</p>
            </div>
            <PreviewIcon label="Pause download" asset={assets.peekPause} className="peek-icon" />
            <PreviewIcon label="Cancel download" asset={assets.peekX} className="peek-icon" />
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Example download progress"
            aria-valuenow={38}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span />
          </div>
        </div>
        <div
          className={`spike-layer ${state === "expanded" ? "active" : ""}`}
          aria-hidden={state !== "expanded"}
        >
          <Expanded />
        </div>
        <div
          className={`spike-layer drop-content ${state === "drop" ? "active" : ""}`}
          aria-hidden={state !== "drop"}
        >
          <div className="drop-header">
            <strong>Drop to nab</strong>
            <span className="muted">
              {payloadKind === "link"
                ? "1 link"
                : payloadKind === "files"
                  ? "Files"
                  : payloadKind === "text"
                    ? "Text"
                    : "Links, files or text"}
            </span>
          </div>
          <div className="drop-zones">
            {zoneOrder(payloadKind).map((zone) => (
              <div
                key={zone}
                data-drop-zone={zone}
                className={`drop-zone ${(over ?? zoneOrder(payloadKind)[0]) === zone ? "over" : ""}`}
              >
                <Icon asset={dropIcons[selectedZone][zone]} />
                <strong>{zones[zone].label}</strong>
                <span className="muted">{zones[zone].hint}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {receipt && (
        <p className="spike-receipt" role="status">
          {receipt.message} · {receipt.kind} · {receipt.zone}
        </p>
      )}
      {query.has("controls") && (
        <nav className="spike-controls" aria-label="Spike state controls">
          {states.map((state) => (
            <Button
              key={state}
              className="spike-button"
              onClick={() => window.nabbitIslandSpike?.setState(state)}
            >
              {state}
            </Button>
          ))}
        </nav>
      )}
    </main>
  );
}
