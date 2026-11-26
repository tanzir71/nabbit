import { useState } from "react";
import { Button } from "../../components/Button";
import { PresetChip } from "../../components/PresetChip";
import { Select } from "../../components/Select";
import { Field } from "../../components/Field";
import { Toggle } from "../../components/Toggle";
import type { AppSettings, DownloadBrowser, DownloadFormat } from "../../lib/types";
import { sizeLabel } from "./model";
import { Remember, type SheetControls } from "./SheetCommon";
import { SheetIcon, SheetRadio } from "./SheetIcon";
export function OptionsSheet({
  metadata,
  options,
  setOptions,
  busy,
  settings,
  browser,
  onBrowser,
  onDownload,
  remember,
  onRemember,
  onKind,
  retry = false,
}: SheetControls & {
  settings: AppSettings;
  browser?: DownloadBrowser;
  onBrowser: (value: DownloadBrowser | undefined) => void;
  onDownload: () => void;
  remember: boolean;
  onRemember: (value: boolean) => void;
  retry?: boolean;
}) {
  const [folderEdit, setFolderEdit] = useState(false),
    [customLanguages, setCustomLanguages] = useState(() =>
      Boolean(options.subtitles && !["en", "all"].includes(options.subtitles.languages.join(","))),
    ),
    [customName, setCustomName] = useState(() =>
      Boolean(
        options.filenameTemplate &&
        !["%(title)s [%(id)s].%(ext)s", "%(title)s.%(ext)s"].includes(options.filenameTemplate),
      ),
    );
  const video = ["mp4", "mkv", "webm"].includes(options.format);
  const quality = metadata.qualities ?? [];
  const subtitle = options.subtitles
    ? `${options.subtitles.languages.join(",")}:${options.subtitles.embed ? "embed" : "file"}`
    : "off";
  const subValues = ["off", ...(video ? ["en:embed", "all:embed"] : []), "en:file", "all:file"];
  const update = (patch: Partial<typeof options>) => setOptions({ ...options, ...patch });
  return (
    <>
      <div className="sheet-body options-body">
        <section>
          <h2>FORMAT</h2>
          <div className="sheet-chips" role="group" aria-label="Format">
            {(["mp4", "mkv", "webm", "mp3", "m4a", "opus"] as DownloadFormat[]).map((f) => (
              <PresetChip
                key={f}
                selected={options.format === f}
                disabled={busy}
                onClick={() =>
                  update({
                    format: f,
                    height: ["mp4", "mkv", "webm"].includes(f) ? (options.height ?? 1080) : null,
                    subtitles:
                      options.subtitles && !["mp4", "mkv", "webm"].includes(f)
                        ? { ...options.subtitles, embed: false }
                        : options.subtitles,
                  })
                }
              >
                {f === "webm" ? "WebM" : f === "opus" ? "Opus" : f.toUpperCase()}
              </PresetChip>
            ))}
          </div>
        </section>
        <section>
          <h2>QUALITY</h2>
          {video ? (
            <div className="sheet-quality" role="radiogroup" aria-label="Video quality">
              {[
                ...quality,
                ...(options.height != null && !quality.some((q) => q.height === options.height)
                  ? [{ height: options.height, estimatedBytes: null, fps: null }]
                  : []),
              ].map((q) => (
                <label key={q.height} className={options.height === q.height ? "is-selected" : ""}>
                  <input
                    className="sheet-native"
                    type="radio"
                    name="height"
                    value={q.height}
                    checked={options.height === q.height}
                    onChange={() => update({ height: q.height })}
                  />
                  <SheetRadio checked={options.height === q.height} />
                  <span>
                    {q.height}p{q.fps ? ` · ${q.fps} fps` : ""}
                  </span>
                  <code>
                    {q.estimatedBytes == null ? "Size unknown" : sizeLabel(q.estimatedBytes)}
                  </code>
                </label>
              ))}
              {options.height === null && (
                <label className="is-selected">
                  <input
                    className="sheet-native"
                    type="radio"
                    name="height"
                    checked={options.height === null}
                    onChange={() => update({ height: null })}
                  />
                  <SheetRadio checked={options.height === null} />
                  <span>Best available</span>
                  <code>Auto</code>
                </label>
              )}
            </div>
          ) : (
            <p>
              {options.format === "mp3" ? "320 kbps MP3" : "Best available audio"} · Size unknown
            </p>
          )}
        </section>
        <section className="sheet-extras">
          <h2>EXTRAS</h2>
          <SheetSelect
            label="Subtitles"
            value={customLanguages ? "custom" : subValues.includes(subtitle) ? subtitle : "custom"}
            onChange={(e) => {
              const v = e.target.value;
              setCustomLanguages(v === "custom");
              if (v === "custom")
                update({ subtitles: options.subtitles ?? { languages: ["en"], embed: video } });
              else if (v === "off") update({ subtitles: null });
              else {
                const [lang, mode] = v.split(":");
                update({ subtitles: { languages: [lang], embed: mode === "embed" } });
              }
            }}
          >
            <option value="off">Off</option>
            {video && (
              <>
                <option value="en:embed">English · embed</option>
                <option value="all:embed">All languages · embed</option>
              </>
            )}
            <option value="en:file">English · file</option>
            <option value="all:file">All languages · file</option>
            <option value="custom">Choose languages…</option>
          </SheetSelect>
          {customLanguages && (
            <>
              <Field
                label="Subtitle languages"
                description="Comma-separated language codes"
                value={options.subtitles?.languages.join(",") ?? ""}
                onChange={(e) =>
                  update({
                    subtitles: {
                      languages: e.target.value.split(","),
                      embed: options.subtitles?.embed ?? video,
                    },
                  })
                }
              />
              <SheetSelect
                label="Subtitle output"
                value={options.subtitles?.embed ? "embed" : "file"}
                onChange={(e) =>
                  update({
                    subtitles: {
                      languages: options.subtitles?.languages ?? ["en"],
                      embed: e.target.value === "embed",
                    },
                  })
                }
              >
                {video && <option value="embed">Embed in video</option>}
                <option value="file">Write subtitle file</option>
              </SheetSelect>
            </>
          )}
          <SheetSelect
            label="Chapters"
            description="Or split into one file per chapter"
            value={options.chapters}
            onChange={(e) => update({ chapters: e.target.value as typeof options.chapters })}
          >
            <option value="off">Off</option>
            <option value="keep">Keep as markers</option>
            <option value="split">Split into files</option>
          </SheetSelect>
          <SheetSelect
            label="SponsorBlock"
            description="Mark or cut sponsor segments"
            value={options.sponsorBlock}
            onChange={(e) =>
              update({ sponsorBlock: e.target.value as typeof options.sponsorBlock })
            }
          >
            <option value="off">Off</option>
            <option value="mark">Mark segments</option>
            <option value="cut">Cut sponsors</option>
          </SheetSelect>
          <Toggle
            label="Embed thumbnail and metadata"
            checked={options.embedThumbnail && options.embedMetadata}
            onChange={(v) => update({ embedThumbnail: v, embedMetadata: v })}
          />
        </section>
        <section className="sheet-save">
          <h2>SAVE</h2>
          <div className="sheet-folder">
            <SheetIcon name="folder" />
            {folderEdit ? (
              <input
                aria-label="Output folder"
                className="sheet-folder-input"
                autoFocus
                value={options.outputDir ?? settings.outputDir}
                onChange={(e) => update({ outputDir: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setFolderEdit(false);
                  }
                }}
              />
            ) : (
              <code title={options.outputDir ?? settings.outputDir}>
                {options.outputDir || settings.outputDir || "Downloads\\Nabbit"}
              </code>
            )}
            <Button variant="ghost" size="sm" onClick={() => setFolderEdit(!folderEdit)}>
              {folderEdit ? "Done" : "Change"}
            </Button>
          </div>
          <SheetSelect
            label="Name files"
            value={
              customName
                ? "custom"
                : options.filenameTemplate == null
                  ? "default"
                  : options.filenameTemplate === "%(title)s [%(id)s].%(ext)s"
                    ? settings.filenameTemplate === "%(title)s [%(id)s].%(ext)s"
                      ? "default"
                      : "title-id"
                    : options.filenameTemplate === "%(title)s.%(ext)s"
                      ? "title"
                      : "custom"
            }
            onChange={(e) => {
              setCustomName(e.target.value === "custom");
              if (e.target.value !== "custom")
                update({
                  filenameTemplate:
                    e.target.value === "default"
                      ? null
                      : e.target.value === "title-id"
                        ? "%(title)s [%(id)s].%(ext)s"
                        : "%(title)s.%(ext)s",
                });
            }}
          >
            <option value="default">
              {settings.filenameTemplate === "%(title)s [%(id)s].%(ext)s"
                ? "{title} [{id}]"
                : settings.filenameTemplate === "%(title)s.%(ext)s"
                  ? "{title}"
                  : "Default template"}
            </option>
            {settings.filenameTemplate !== "%(title)s [%(id)s].%(ext)s" && (
              <option value="title-id">{"{title} [{id}]"}</option>
            )}
            <option value="title">{"{title}"}</option>
            <option value="custom">Custom template…</option>
          </SheetSelect>
          {customName && (
            <Field
              label="Custom filename template"
              value={options.filenameTemplate ?? settings.filenameTemplate}
              onChange={(e) => update({ filenameTemplate: e.target.value })}
            />
          )}
          <SheetSelect
            label="Signed-in videos"
            description="Uses cookies from a browser you choose, only for this download"
            value={browser ?? ""}
            onChange={(e) =>
              onBrowser((e.target.value || undefined) as DownloadBrowser | undefined)
            }
          >
            <option value="">No browser</option>
            {["chrome", "edge", "firefox", "brave"].map((b) => (
              <option key={b} value={b}>
                {b[0].toUpperCase() + b.slice(1)}
              </option>
            ))}
          </SheetSelect>
        </section>
        <details className="sheet-advanced">
          <summary>Advanced</summary>
          {!metadata.isPlaylist && (
            <Button variant="ghost" onClick={() => onKind("trim")}>
              Trim and chapters
            </Button>
          )}
          {video && (
            <Select
              label="Quality limit"
              value={options.height ?? "best"}
              onChange={(e) =>
                update({ height: e.target.value === "best" ? null : Number(e.target.value) })
              }
            >
              <option value="best">Best available</option>
              {quality.map((q) => (
                <option key={q.height} value={q.height}>
                  {q.height}p
                </option>
              ))}
            </Select>
          )}
          <Field
            label="Filename template"
            value={options.filenameTemplate ?? settings.filenameTemplate}
            onChange={(e) => update({ filenameTemplate: e.target.value })}
          />
          <Field
            label="Subtitle languages"
            description="Comma-separated language codes, such as en,bn or all"
            disabled={!options.subtitles}
            value={options.subtitles?.languages.join(",") ?? ""}
            onChange={(e) =>
              update({
                subtitles: {
                  languages: e.target.value.split(","),
                  embed: options.subtitles?.embed ?? false,
                },
              })
            }
          />
          <Field
            label="Speed limit"
            placeholder="Unlimited, or 2M"
            value={options.speedLimit ?? ""}
            onChange={(e) => update({ speedLimit: e.target.value || null })}
          />
          <p>Audio/video services may not support every option.</p>
        </details>
      </div>
      <footer className="sheet-footer">
        {retry ? (
          <span>Update this download</span>
        ) : (
          <Remember checked={remember} onChange={onRemember} site={metadata.normalizedUrl} />
        )}
        <span className="nab-spacer" />
        <Button data-sheet-primary variant="primary" disabled={busy} onClick={onDownload}>
          <SheetIcon name="download" />
          {busy ? "Adding…" : retry ? "Retry download" : "Download"}
        </Button>
      </footer>
    </>
  );
}
function SheetSelect(props: React.ComponentProps<typeof Select>) {
  return (
    <div className="sheet-select-row">
      <Select {...props} />
    </div>
  );
}
