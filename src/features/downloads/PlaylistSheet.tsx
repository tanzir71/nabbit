import { useState } from "react";
import { Button } from "../../components/Button";
import { SheetIcon } from "./SheetIcon";
import type { SheetControls } from "./SheetCommon";
import { playlistSize, selection, selectionLabel } from "./sheetModel";
import { sizeLabel } from "./model";
import { duration } from "../../lib/islandPresentation";
export function PlaylistSheet({
  metadata,
  options,
  busy,
  onDownload,
  onKind,
}: SheetControls & { onDownload: (indices: number[]) => void }) {
  const entries = metadata.details?.entries ?? [];
  const available = entries.filter((e) => e.url).map((e) => e.index);
  const [selected, setSelected] = useState<number[]>(() => {
    try {
      return options.playlistItems ? selection(options.playlistItems, entries) : available;
    } catch {
      return [];
    }
  });
  const [range, setRange] = useState(options.playlistItems ?? selectionLabel(selected)),
    [error, setError] = useState(() => {
      try {
        if (options.playlistItems) selection(options.playlistItems, entries);
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
  const change = (next: number[]) => {
    setSelected(next);
    setRange(selectionLabel(next));
    setError("");
  };
  const video = ["mp4", "mkv", "webm"].includes(options.format);
  const bytes = video
    ? playlistSize(
        entries.filter((e) => selected.includes(e.index)),
        options.height,
      )
    : null;
  return (
    <>
      <div className="sheet-selection-tools">
        <SheetCheck
          label="Select all"
          checked={available.length > 0 && selected.length === available.length}
          mixed={selected.length > 0 && selected.length < available.length}
          disabled={busy || !available.length}
          onChange={() => change(selected.length === available.length ? [] : available)}
        />
        <span className="nab-spacer" />
        <label className="sheet-range-label">
          Range
          <input
            value={range}
            className="n-input font-mono"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "playlist-range-error" : undefined}
            disabled={busy}
            placeholder="1–5"
            onChange={(e) => {
              setRange(e.target.value);
              try {
                setSelected(selection(e.target.value, entries));
                setError("");
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        </label>
      </div>
      <div className="playlist-body">
        <div className="playlist-items" role="group" aria-label="Playlist videos" tabIndex={0}>
          {entries.map((e, i) => (
            <div
              className={`sheet-playlist-item ${selected.includes(e.index) ? "is-selected" : ""}`}
              key={e.index}
            >
              <SheetCheck
                label={`Select ${e.title}`}
                checked={selected.includes(e.index)}
                disabled={!e.url || busy}
                onChange={() =>
                  change(
                    selected.includes(e.index)
                      ? selected.filter((n) => n !== e.index)
                      : [...selected, e.index],
                  )
                }
              />
              <code className="playlist-index">{String(e.index).padStart(2, "0")}</code>
              <span
                className="playlist-thumb"
                aria-hidden="true"
                style={
                  e.thumbnail
                    ? { backgroundImage: `url(${JSON.stringify(e.thumbnail)})` }
                    : {
                        backgroundImage: `linear-gradient(150.64224645720873deg, rgb(${Math.round(51 + (i % 9) * 12.75)},77,89) 0%,rgb(140,${Math.round(128 - (i % 9) * (40 / 7))},115) 71.429%)`,
                      }
                }
              />
              <span className="playlist-title" title={e.title}>
                {e.title}
                {!e.url && <span className="sheet-caption"> · Unavailable</span>}
              </span>
              <code>{e.duration == null ? "—" : duration(e.duration)}</code>
            </div>
          ))}
        </div>
        {error && (
          <p id="playlist-range-error" role="alert" className="sheet-inline-error">
            {error}
          </p>
        )}
        {!entries.length && (
          <p className="sheet-caption">
            Playlist items could not be loaded. Close and review the link again.
          </p>
        )}
        {metadata.details?.truncated && (
          <p className="sheet-caption">
            Showing {entries.length} loaded items of {metadata.playlistCount ?? "this playlist"}.
            Only loaded, available items can be selected.
          </p>
        )}
        <details className="sheet-advanced">
          <summary>Advanced</summary>
          <Button variant="ghost" onClick={() => onKind("options")}>
            Download options
          </Button>
        </details>
      </div>
      <footer className="sheet-footer">
        <p className="sheet-caption">
          {selected.length} selected ·{" "}
          {bytes == null ? "Size unknown" : `about ${sizeLabel(bytes)}`} ·{" "}
          {video
            ? options.height
              ? `${options.format.toUpperCase()} ${options.height}p`
              : "Best video"
            : options.format.toUpperCase()}
        </p>
        <span className="nab-spacer" />
        <Button
          data-sheet-primary
          variant="primary"
          disabled={busy || !selected.length || Boolean(error)}
          onClick={() => onDownload(selected)}
        >
          <SheetIcon name="download" />
          {busy ? "Adding…" : `Download ${selected.length}`}
        </Button>
      </footer>
    </>
  );
}
function SheetCheck({
  label,
  checked,
  mixed = false,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <label className="sheet-check">
      <input
        type="checkbox"
        className="sheet-native"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        ref={(n) => {
          if (n) n.indeterminate = mixed;
        }}
        onChange={onChange}
      />
      <span className="sheet-checkbox" data-mixed={mixed} aria-hidden="true">
        {checked ? <SheetIcon name="check" /> : null}
      </span>
      {label === "Select all" && <span>Select all</span>}
    </label>
  );
}
