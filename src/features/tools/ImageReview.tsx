import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Toggle } from "../../components/Toggle";
import { Field } from "../../components/Field";
import { PresetChip } from "../../components/PresetChip";
import { SheetIcon } from "../downloads/SheetIcon";
import { shelfApi } from "../shelf/api";
import { toolsApi, acceptsFile, type Tool, type ToolPreset } from "./api";
import { imageApi, defaultImageOptions, type ImageInspection, type ImageOptions } from "./imageApi";
import imageIcon from "../../assets/image-tools/facb1.svg?url";
import convertIcon from "../../assets/image-tools/830d6.svg?url";
import thumb from "../../assets/image-tools/09fa1.svg?url";
import advanced from "../../assets/media-tools/c80e9.svg?url";
import "./images.css";
const name = (path: string) => path.split(/[\\/]/).pop() ?? path;
export function ImageReview({
  tool,
  inputs,
  close,
}: {
  tool: Tool;
  inputs: string[];
  close: () => void;
}) {
  const [paths, setPaths] = useState(inputs.filter((p) => acceptsFile(tool, p)));
  const [sources, setSources] = useState<string[]>([]);
  const [inspection, setInspection] = useState(0);
  const [info, setInfo] = useState<Record<string, ImageInspection>>({});
  const [options, setOptions] = useState<ImageOptions>(() => ({
    ...defaultImageOptions(),
    format: tool.id === "to-jpg" ? ("jpg" as const) : ("original" as const),
  }));
  const [presets, setPresets] = useState<ToolPreset[]>([]),
    [preset, setPreset] = useState("discord"),
    [cap, setCap] = useState(20);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const qualityEdited = useRef(false);
  const working = useRef(false),
    requests = useRef(new Map<string, string>());
  useEffect(() => {
    let active = true;
    void Promise.all([shelfApi.list(), toolsApi.presets()])
      .then(([items, p]) => {
        if (active) {
          setSources(
            items.filter((i) => i.available && acceptsFile(tool, i.path)).map((i) => i.path),
          );
          setPresets(p);
          if (!qualityEdited.current)
            setOptions((o) => ({
              ...o,
              quality:
                p.find((i) => i.id === (tool.id === "to-jpg" ? o.format : tool.presets[0]))
                  ?.quality ?? o.quality,
            }));
          setCap(p.find((i) => i.id === "discord")?.maxMb ?? 20);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [tool]);
  useEffect(() => {
    let active = true;
    setInfo({});
    // Bound memory for batches of large files and stop scheduling reads when closed.
    void (async () => {
      for (const path of paths) {
        if (!active) return;
        let result: ImageInspection;
        try {
          result = await imageApi.inspect(path);
        } catch (error) {
          result = { info: null, error: String(error), codecRequired: false };
        }
        if (active) setInfo((old) => ({ ...old, [path]: result }));
      }
    })();
    return () => {
      active = false;
    };
  }, [paths, inspection]);
  const fit = tool.id === "fit-size",
    strip = tool.id === "strip-metadata",
    convert = tool.id === "to-jpg";
  const run = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      for (const path of paths) {
        const presetId = fit ? preset : strip ? "strip" : convert ? options.format : "smaller";
        const key = JSON.stringify([path, options, presetId, fit ? cap : null]);
        let id = requests.current.get(key);
        if (!id) {
          id = crypto.randomUUID();
          requests.current.set(key, id);
        }
        await imageApi.start(id, tool.id, path, presetId, options, fit ? cap : null);
      }
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="media-review image-review"
      aria-label={`${tool.name} options`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) close();
      }}
    >
      <header className="media-header" data-tauri-drag-region>
        <div>
          <h1>{convert ? "Convert images" : tool.name}</h1>
          <p>
            {paths.length
              ? `${paths.length} ${paths.length === 1 ? "photo" : "photos"} selected`
              : "Choose photos from the Shelf or a file"}
          </p>
        </div>
        <IconButton label="Close image options" size={28} disabled={busy} onClick={close}>
          <SheetIcon name="close" />
        </IconButton>
      </header>
      <div className="media-body">
        {!!paths.length && (
          <ul className="image-inputs">
            {paths.map((path) => (
              <li key={path}>
                <img
                  src={imageIcon}
                  width={15}
                  height={15}
                  data-asset="image-tools/facb1.svg"
                  alt=""
                />
                <div>
                  <span title={path}>{name(path)}</span>
                  <p>
                    {info[path]?.info
                      ? `${(info[path].info!.bytes / 1_000_000).toFixed(1)} MB`
                      : "Inspecting…"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {(!paths.length || sources.some((p) => !paths.includes(p))) && (
          <label className="media-caption">
            Add from Shelf
            <select
              aria-label="Add photo from Shelf"
              value=""
              disabled={busy}
              onChange={(e) => setPaths((p) => [...p, e.target.value])}
            >
              <option value="" disabled>
                Choose a photo
              </option>
              {sources
                .filter((p) => !paths.includes(p))
                .map((p) => (
                  <option value={p} key={p}>
                    {name(p)}
                  </option>
                ))}
            </select>
          </label>
        )}
        {!paths.length && (
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                const p = await toolsApi.pick(tool.id);
                if (p) setPaths([p]);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Choose file…
          </Button>
        )}
        {paths.map((path) =>
          info[path]?.error ? (
            <p key={path} role="alert">
              {name(path)}: {info[path].error}
            </p>
          ) : null,
        )}
        {paths.some((path) => info[path]?.codecRequired) && (
          <div className="image-codec">
            <p>
              HEIC needs Windows HEIF and HEVC support. HEVC may cost $0.99. Nabbit opens the Store
              page; installation is your choice.
            </p>
            <Button
              variant="secondary"
              onClick={() => void imageApi.codec("heif").catch((e) => setError(String(e)))}
            >
              Get HEIF extension
            </Button>
            <Button
              variant="secondary"
              onClick={() => void imageApi.codec("hevc").catch((e) => setError(String(e)))}
            >
              Get HEVC extension
            </Button>
            <Button variant="secondary" onClick={() => setInspection((n) => n + 1)}>
              Check again
            </Button>
          </div>
        )}
        {fit && (
          <div>
            <h2>SIZE LIMIT</h2>
            <div className="media-chips">
              {presets
                .filter((p) => p.maxMb && tool.presets.includes(p.id))
                .map((p) => (
                  <PresetChip
                    key={p.id}
                    selected={preset === p.id}
                    disabled={busy}
                    onClick={() => {
                      setPreset(p.id);
                      setCap(p.maxMb!);
                      if (!qualityEdited.current) setOptions((o) => ({ ...o, quality: p.quality }));
                    }}
                  >
                    {p.name}
                  </PresetChip>
                ))}
            </div>
            <Field
              label="Maximum MB"
              type="number"
              min={1}
              max={100000}
              value={cap}
              disabled={busy}
              onChange={(e) => setCap(Number(e.target.value))}
            />
            <p className="media-caption">
              Up to three attempts, checked against the actual output size.
            </p>
          </div>
        )}
        {!strip && (
          <>
            <div>
              <h2>FORMAT</h2>
              <div className="media-chips">
                {!convert && (
                  <PresetChip
                    selected={options.format === "original"}
                    disabled={busy}
                    onClick={() => setOptions((o) => ({ ...o, format: "original" }))}
                  >
                    Auto
                  </PresetChip>
                )}
                {(["jpg", "png", "webp", "avif"] as const).map((f) => (
                  <PresetChip
                    key={f}
                    selected={options.format === f}
                    disabled={busy}
                    onClick={() =>
                      setOptions((o) => ({
                        ...o,
                        format: f,
                        quality: qualityEdited.current
                          ? o.quality
                          : (presets.find((p) => p.id === f)?.quality ?? o.quality),
                      }))
                    }
                  >
                    {{ jpg: "JPG", png: "PNG", webp: "WebP", avif: "AVIF" }[f]}
                  </PresetChip>
                ))}
              </div>
            </div>
            <label className="image-quality">
              <span>
                QUALITY <output>{options.quality}</output>
              </span>
              <input
                aria-label="Image quality"
                type="range"
                min={1}
                max={100}
                value={options.quality ?? 82}
                disabled={
                  busy ||
                  options.format === "png" ||
                  (options.format === "original" &&
                    paths.length > 0 &&
                    paths.every((p) => /\.(png|svg)$/i.test(p)))
                }
                style={
                  {
                    "--quality": `${options.quality}%`,
                    "--image-thumb": `url("${thumb}")`,
                  } as CSSProperties
                }
                onChange={(e) => {
                  qualityEdited.current = true;
                  setOptions((o) => ({ ...o, quality: Number(e.target.value) }));
                }}
              />
            </label>
            <label className="image-width">
              <span>
                Max width<small>Keep the original ratio</small>
              </span>
              <select
                aria-label="Maximum image width"
                value={options.maxWidth ?? ""}
                disabled={busy}
                onChange={(e) =>
                  setOptions((o) => ({
                    ...o,
                    maxWidth: e.target.value ? Number(e.target.value) : null,
                  }))
                }
              >
                <option value="">Original</option>
                {[3840, 2560, 1920, 1280, 800].map((n) => (
                  <option key={n} value={n}>
                    {n} px
                  </option>
                ))}
              </select>
            </label>
            <Toggle
              label="Remove location and camera data"
              checked={options.stripMetadata}
              disabled={busy}
              onChange={(stripMetadata) => setOptions((o) => ({ ...o, stripMetadata }))}
            />
          </>
        )}
        <details>
          <summary>
            <img src={advanced} width={14} height={14} alt="" />
            Advanced: colour profile, output folder, keep original date
          </summary>
          <div className="image-advanced">
            {!convert && (
              <p className="media-caption">
                Auto keeps supported image formats; HEIC becomes JPG and SVG becomes PNG.
              </p>
            )}
            {paths.map((path) => (
              <div className="image-edit-row" key={path}>
                <span>
                  {name(path)}
                  {info[path]?.info
                    ? ` · ${info[path].info!.width} × ${info[path].info!.height}`
                    : ""}
                </span>
                <IconButton
                  size={28}
                  label={`Remove ${name(path)}`}
                  disabled={busy}
                  onClick={() => setPaths((p) => p.filter((v) => v !== path))}
                >
                  <SheetIcon name="close" />
                </IconButton>
              </div>
            ))}
            <Toggle
              label="Keep colour profile"
              checked={options.keepProfile}
              disabled={busy}
              onChange={(keepProfile) => setOptions((o) => ({ ...o, keepProfile }))}
            />
            <Toggle
              label="Keep original file dates"
              checked={options.keepDates}
              disabled={busy}
              onChange={(keepDates) => setOptions((o) => ({ ...o, keepDates }))}
            />
            <Field
              label="Output folder"
              placeholder="Next to the originals"
              value={options.outputDir ?? ""}
              disabled={busy}
              onChange={(e) => setOptions((o) => ({ ...o, outputDir: e.target.value || null }))}
            />
            <p className="media-caption">
              Capture dates stay in EXIF unless location and camera data are removed. JPG uses a
              white background for transparency.
            </p>
          </div>
        </details>
        {error && <p role="alert">{error}</p>}
      </div>
      <footer className="image-footer">
        <p>
          {options.outputDir ? "Saved to chosen folder" : "Saved next to the originals"}
          {options.keepDates ? " · dates kept" : ""}
        </p>
        <Button
          variant="primary"
          disabled={
            busy ||
            !paths.length ||
            paths.some((p) => !info[p]?.info) ||
            (fit && (!Number.isInteger(cap) || cap < 1 || cap > 100000))
          }
          onClick={() => void run()}
        >
          <img src={convertIcon} width={16} height={16} data-asset="image-tools/830d6.svg" alt="" />
          {busy
            ? "Adding to queue…"
            : `${convert ? "Convert" : strip ? "Clean" : "Make smaller"} ${paths.length} ${paths.length === 1 ? "photo" : "photos"}`}
        </Button>
      </footer>
    </section>
  );
}
