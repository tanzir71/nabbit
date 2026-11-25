import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "../../src/components/Button";
import { IconButton } from "../../src/components/IconButton";
import { assets } from "./assets";

const states = ["idle", "live", "peek", "expanded"] as const;
type SpikeState = (typeof states)[number];
declare global {
  interface Window {
    nabbitIslandSpike?: { setState: (state: SpikeState) => void; ready: true };
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
  const [surface, setSurface] = useState<{ state: SpikeState; motion: string }>({
    state: "idle",
    motion: "live",
  });
  useEffect(() => {
    const setState = (next: SpikeState) => {
      if (!states.includes(next)) throw new Error(`Invalid spike state: ${String(next)}`);
      flushSync(() =>
        setSurface((previous) => ({
          state: next,
          motion: states.indexOf(next) < states.indexOf(previous.state) ? "collapse" : next,
        })),
      );
    };
    window.nabbitIslandSpike = { ready: true, setState };
    return () => {
      delete window.nabbitIslandSpike;
    };
  }, []);
  return (
    <main className="spike-frame" aria-label="Island geometry and motion spike">
      <div className="spike-pill" data-state={surface.state} data-motion={surface.motion}>
        <div
          className={`spike-layer live-content ${surface.state === "live" ? "active" : ""}`}
          aria-hidden={surface.state !== "live"}
        >
          <Icon asset={assets.liveRing} />
          <span className="live-title muted" title={title}>
            {title}
          </span>
          <span className="mono">38%</span>
        </div>
        <div
          className={`spike-layer peek-content ${surface.state === "peek" ? "active" : ""}`}
          aria-hidden={surface.state !== "peek"}
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
          className={`spike-layer ${surface.state === "expanded" ? "active" : ""}`}
          aria-hidden={surface.state !== "expanded"}
        >
          <Expanded />
        </div>
      </div>
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
