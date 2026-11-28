import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Toggle } from "../../components/Toggle";
import { PresetChip } from "../../components/PresetChip";
import { api } from "../../lib/ipc";
import type { DownloadOptions } from "../../lib/types";
import type { SheetControls } from "./SheetCommon";
import { SheetIcon } from "./SheetIcon";
import {
  covers,
  parseSection,
  snap,
  timecode,
  toggleChapter,
  union,
  type Section,
} from "./sheetModel";

export function TrimSheet({
  metadata,
  options,
  setOptions,
  busy,
  setProblem,
  onKind,
  onDownload,
  local = false,
}: SheetControls & { onDownload: (options: DownloadOptions) => void; local?: boolean }) {
  const duration = Math.round((metadata.duration ?? 0) * 1000);
  const [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [error, setError] = useState("");
  const ranges = options.sections.length ? options.sections : [{ startMs: 0, endMs: duration }];
  const current = ranges[0];
  const chapters = (metadata.details?.chapters ?? []).filter((c) => c.endMs <= duration);
  useEffect(() => {
    setStart(timecode(options.sections[0]?.startMs ?? 0));
    setEnd(timecode(options.sections[0]?.endMs ?? duration));
    setError("");
  }, [options.sections, duration]);
  const replace = (range: Section) =>
    setOptions({ ...options, sections: union([range, ...options.sections.slice(1)]) });
  const commit = () => {
    try {
      const r = parseSection(start, end, duration);
      replace(r);
      setError("");
      return r;
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      return null;
    }
  };
  const handle = (value: number, edge: "startMs" | "endMs") => {
    const ms = Math.max(0, Math.min(duration, snap(value, chapters)));
    const next = { ...current, [edge]: ms };
    if (next.startMs < next.endMs) {
      replace(next);
      setError("");
    }
  };
  const thumb = metadata.thumbnail ?? metadata.details?.thumbnails[0];
  return (
    <>
      <div className="sheet-body trim-body">
        {!local && (
          <div
            className="sheet-preview"
            style={thumb ? { backgroundImage: `url(${JSON.stringify(thumb)})` } : undefined}
          >
            <button
              className="sheet-play"
              aria-label="Preview on source site"
              title="Preview on source site"
              onClick={() =>
                void api
                  .previewDownloadSource(metadata.normalizedUrl, current.startMs)
                  .catch((e) => setProblem(String(e)))
              }
            >
              <SheetIcon name="play" />
            </button>
          </div>
        )}
        <div
          className={`sheet-filmstrip${local ? " sheet-filmstrip--local" : ""}`}
          role="group"
          aria-label="Trim range"
        >
          {!local && (
            <div className="sheet-frames" aria-hidden="true">
              {Array.from({ length: 8 }, (_, i) => {
                const image = metadata.details?.thumbnails[i] ?? thumb;
                return (
                  <span
                    key={i}
                    style={{
                      opacity: ranges.some(
                        (r) =>
                          r.startMs <= (duration * (i + 0.5)) / 8 &&
                          r.endMs >= (duration * (i + 0.5)) / 8,
                      )
                        ? 1
                        : 0.35,
                      ...(image
                        ? { backgroundImage: `url(${JSON.stringify(image)})` }
                        : {
                            backgroundImage: `linear-gradient(140.3009265165257deg, rgb(${[41, 48, 56, 64, 71, 79, 87, 94][i]}, ${[56, 61, 66, 71, 77, 82, 87, 92][i]}, 77) 0%, rgb(107, ${140 - i * 5}, 128) 71.429%)`,
                          }),
                    }}
                  />
                );
              })}
            </div>
          )}
          {duration > 0 &&
            ranges.map((r, i) => (
              <span
                key={i}
                className="sheet-range-selection"
                style={{
                  left: `${(r.startMs / duration) * 100}%`,
                  width: `${((r.endMs - r.startMs) / duration) * 100}%`,
                }}
              />
            ))}
          <input
            type="range"
            className="sheet-range"
            aria-label="Trim start handle"
            min={0}
            max={duration || 1}
            step={100}
            value={current.startMs}
            aria-valuetext={timecode(current.startMs)}
            disabled={busy || !duration}
            onChange={(e) => handle(Number(e.target.value), "startMs")}
            style={
              {
                "--handle": `${duration ? (current.startMs / duration) * 100 : 0}%`,
              } as CSSProperties
            }
          />
          <input
            type="range"
            className="sheet-range"
            aria-label="Trim end handle"
            min={0}
            max={duration || 1}
            step={100}
            value={current.endMs}
            aria-valuetext={timecode(current.endMs)}
            disabled={busy || !duration}
            onChange={(e) => handle(Number(e.target.value), "endMs")}
            style={
              {
                "--handle": `${duration ? (current.endMs / duration) * 100 : 100}%`,
              } as CSSProperties
            }
          />
        </div>
        <div className="sheet-times">
          <Field
            label="Start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            onBlur={commit}
            className="font-mono"
          />
          <Field
            label="End"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            onBlur={commit}
            className="font-mono"
          />
          <div className="sheet-length">
            <span>
              Length{options.sections.length > 1 ? ` · ${options.sections.length} sections` : ""}
            </span>
            <code>{timecode(ranges.reduce((n, r) => n + r.endMs - r.startMs, 0))}</code>
          </div>
        </div>
        {error && (
          <p role="alert" className="sheet-inline-error">
            {error}
          </p>
        )}
        {!duration && (
          <p role="alert">Trim needs a known video duration. Reload a single video to continue.</p>
        )}
        {!local && (
          <section>
            <h2>CHAPTERS</h2>
            <div className="sheet-chips">
              {chapters.length ? (
                chapters.map((c, i) => (
                  <PresetChip
                    key={i}
                    selected={covers(options.sections, c)}
                    meta={timecode(c.startMs).replace(/\.0$/, "").replace(/^0/, "")}
                    disabled={busy}
                    onClick={() => {
                      setOptions({ ...options, sections: toggleChapter(options.sections, c) });
                      setError("");
                    }}
                  >
                    {c.title}
                  </PresetChip>
                ))
              ) : (
                <p className="sheet-caption">No chapters are available for this video.</p>
              )}
            </div>
          </section>
        )}
        <p className="sheet-caption">
          {local
            ? "Creates a new MP4 of the selected section with precise boundaries. Original kept."
            : "Downloads only the selected section, so a short clip does not fetch the whole video."}
        </p>
        {!local && (
          <details className="sheet-advanced">
            <summary>Advanced</summary>
            <Button variant="ghost" onClick={() => onKind("options")}>
              Download options
            </Button>
            <Toggle
              label="Precise cuts"
              description="Re-encodes at cut points for exact boundaries"
              checked={options.preciseCuts}
              onChange={(v) => {
                const r = commit();
                if (r)
                  setOptions({
                    ...options,
                    sections: union([r, ...options.sections.slice(1)]),
                    preciseCuts: v,
                  });
              }}
            />
          </details>
        )}
      </div>
      <footer className="sheet-footer">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setOptions({ ...options, sections: [], preciseCuts: false })}
        >
          Reset
        </Button>
        <span className="nab-spacer" />
        <Button
          data-sheet-primary
          variant="primary"
          disabled={busy || !duration}
          onClick={() => {
            try {
              const range = parseSection(start, end, duration);
              onDownload({ ...options, sections: union([range, ...options.sections.slice(1)]) });
            } catch (e) {
              setError(String(e instanceof Error ? e.message : e));
            }
          }}
        >
          <SheetIcon name="trim" />
          {busy ? "Adding…" : local ? "Trim video" : "Download section"}
        </Button>
      </footer>
    </>
  );
}
