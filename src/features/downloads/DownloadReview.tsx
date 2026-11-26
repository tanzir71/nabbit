import { useEffect, useRef, useState } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "../../components/Button";
import { PresetChip } from "../../components/PresetChip";
import { Kbd } from "../../components/Kbd";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { api } from "../../lib/ipc";
import { defaultDownloadPresets, defaultDownloadOptions } from "../../lib/downloadPresets";
import type { DownloadOptions, DownloadSheetDraft } from "../../lib/types";
import { duration } from "../../lib/islandPresentation";
import { useAppStore } from "../../store/useAppStore";
import { DownloadIcon } from "./DownloadIcon";
import { estimatedBytes, siteLabel, sizeLabel } from "./model";
import { usePreset } from "./usePreset";
export function DownloadReview({
  island = false,
  active = true,
  memory,
  onMemoryChange,
}: {
  island?: boolean;
  active?: boolean;
  memory?: string;
  onMemoryChange?: (memory: string) => void;
}) {
  const metadata = useAppStore((s) => s.metadata),
    settings = useAppStore((s) => s.settings);
  const stage = useAppStore((s) => s.stageUrl),
    start = useAppStore((s) => s.startDownload);
  const {
    preset,
    ready,
    error: presetError,
    choose,
    edit,
  } = usePreset(metadata?.normalizedUrl ?? "", memory, onMemoryChange);
  const [input, setInput] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const review = async (url: string) => {
    setError("");
    try {
      await stage(url);
      if (!useAppStore.getState().error)
        setInput((value) => (value.trim() === url.trim() ? "" : value));
    } catch (reason) {
      report(reason);
    }
  };
  const sheet = async (
    kind: DownloadSheetDraft["kind"],
    options: DownloadOptions = preset.options,
  ) => {
    if (!metadata || !ready) return;
    try {
      await api.openDownloadSheet({
        kind,
        url: metadata.normalizedUrl,
        options,
        remember: false,
      });
    } catch (reason) {
      report(reason);
    }
  };
  const download = async () => {
    if (!metadata || !ready || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      if (
        metadata.isPlaylist &&
        (preset.options.playlistMode === "playlist" ||
          !new URL(metadata.normalizedUrl).searchParams.get("v"))
      ) {
        await sheet("playlist", {
          ...preset.options,
          playlistMode: "playlist",
          playlistItems:
            preset.options.playlistMode === "playlist" ? preset.options.playlistItems : "1",
        });
        return;
      }
      await start({
        url: metadata.normalizedUrl,
        options: preset.options,
        rememberForSite: false,
      });
    } catch (reason) {
      report(reason);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const startRef = useRef(download);
  startRef.current = download;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        active &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.key === "Enter" &&
        !event.repeat &&
        !event.isComposing
      ) {
        event.preventDefault();
        void startRef.current();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [active]);
  const icon = (name: "trim" | "subtitles" | "download") =>
    island ? (
      <IslandAsset
        group="9:78"
        name={{ trim: "iconScissors", subtitles: "iconCaptions", download: "iconDownload1" }[name]}
      />
    ) : (
      <DownloadIcon name={name} />
    );
  const bytes = metadata ? estimatedBytes(metadata, preset.options) : null;
  const output =
    settings?.outputDir.split(/[\\/]/).filter(Boolean).slice(-2).join("\\") || "Downloads\\Nabbit";
  const options = { ...defaultDownloadOptions(), ...preset.options };
  return (
    <section
      className={`nab-review ${island ? "is-island" : "is-tray"}`}
      aria-label="Download review"
    >
      {(!island || !metadata) && (
        <form
          className="nab-link-field"
          onSubmit={(e) => {
            e.preventDefault();
            void review(input);
          }}
        >
          {!island && <DownloadIcon name="link" />}
          <input
            aria-label="Video URL"
            type="url"
            required
            placeholder="Paste a link, or drop one anywhere on Nabbit"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Button
            size="sm"
            type={input.trim() ? "submit" : "button"}
            onClick={
              input.trim()
                ? undefined
                : () => {
                    void readText()
                      .then((value) => (value ? review(value) : setError("Copy a web link first")))
                      .catch(report);
                  }
            }
          >
            {input.trim() ? "Review" : "Paste"}
          </Button>
        </form>
      )}
      {metadata && (
        <div className="nab-detected">
          <div className="nab-review-top">
            <div
              className="nab-thumbnail"
              style={
                metadata.thumbnail
                  ? { backgroundImage: `url(${JSON.stringify(metadata.thumbnail)})` }
                  : undefined
              }
            >
              {island && metadata.duration != null && (
                <span className="nab-duration">{duration(metadata.duration)}</span>
              )}
            </div>
            <div className="nab-details">
              <h2 title={metadata.normalizedUrl}>{metadata.title}</h2>
              {metadata.isPlaylist && (
                <p className="nab-meta">
                  Playlist
                  {metadata.playlistCount != null ? ` · ${metadata.playlistCount} items` : ""}
                </p>
              )}
              <p className="nab-meta">
                {[
                  metadata.channel || (island ? null : siteLabel(metadata.normalizedUrl)),
                  island
                    ? siteLabel(metadata.normalizedUrl)
                    : metadata.duration != null
                      ? duration(metadata.duration)
                      : null,
                  bytes != null ? `about ${sizeLabel(bytes)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {island && renderPresets()}
            </div>
          </div>
          {!island && renderPresets()}
          {metadata.isPlaylist && (
            <fieldset className="nab-inline-options">
              <legend>Playlist selection</legend>
              <label>
                Download
                <select
                  value={options.playlistMode}
                  onChange={(e) =>
                    edit({ ...options, playlistMode: e.target.value as "video" | "playlist" })
                  }
                >
                  <option value="video">
                    {new URL(metadata.normalizedUrl).searchParams.get("v")
                      ? "This video only"
                      : "First video"}
                  </option>
                  <option value="playlist">Whole playlist</option>
                </select>
              </label>
              <label>
                Items
                <input
                  aria-label="Playlist items"
                  disabled={options.playlistMode !== "playlist"}
                  placeholder="All, or 1-5"
                  value={options.playlistItems ?? ""}
                  onChange={(e) =>
                    edit({ ...options, playlistItems: e.target.value.trim() || null })
                  }
                />
              </label>
            </fieldset>
          )}
          <div className="nab-review-actions">
            <Button
              size="sm"
              variant="ghost"
              className="nab-option-button"
              onClick={() => void sheet("trim")}
              disabled={!ready || metadata.isPlaylist}
              aria-haspopup="dialog"
            >
              {icon("trim")}
              {island ? `Trim · ${options.sections.length ? "selection" : "full"}` : "Trim"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="nab-option-button"
              onClick={() =>
                edit({
                  ...options,
                  subtitles: options.subtitles ? null : { languages: ["en"], embed: true },
                })
              }
              aria-pressed={Boolean(options.subtitles)}
            >
              {icon("subtitles")}
              {island ? `Subtitles ${options.subtitles ? "on" : "off"}` : "Subtitles"}
            </Button>
            {island && (
              <Button
                size="sm"
                variant="ghost"
                className="nab-option-button"
                onClick={() => void sheet("options")}
                aria-haspopup="dialog"
              >
                <IslandAsset group="9:78" name="iconEllipsis" />
                More
              </Button>
            )}
            <span className="nab-spacer" />
            {island && (
              <span className="nab-save-path" title={settings?.outputDir}>
                Saves to {output}
              </span>
            )}
            <Button
              variant="primary"
              className="nab-start"
              disabled={!ready || busy}
              onClick={() => void download()}
              aria-keyshortcuts="Control+Enter"
            >
              {icon("download")}
              {busy ? "Adding…" : island ? "Nab it" : "Download"}
              {island && <Kbd>Enter</Kbd>}
            </Button>
          </div>
        </div>
      )}
      {(error || presetError) && (
        <p role="alert" className="nab-error">
          {error || presetError}
        </p>
      )}
    </section>
  );
  function renderPresets() {
    return (
      <div className="nab-presets" role="group" aria-label="Download preset">
        {defaultDownloadPresets()
          .filter((p) => island || p.id !== "m4a" || preset.id === "m4a")
          .map((p) => {
            const [label, meta] = p.label.replace("…", "").split(" · ");
            return (
              <PresetChip
                key={p.id}
                surface={island ? "island" : "light"}
                selected={preset.id === p.id}
                meta={meta}
                disabled={!ready}
                onClick={() => {
                  if (p.id === "custom") void sheet("options");
                  else choose(p);
                }}
              >
                {label}
              </PresetChip>
            );
          })}
      </div>
    );
  }
}
