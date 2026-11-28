import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Field } from "../../components/Field";
import { Toggle } from "../../components/Toggle";
import { PresetChip } from "../../components/PresetChip";
import { DesignIcon } from "../../components/DesignIcon";
import { defaultDownloadOptions } from "../../lib/downloadPresets";
import { SheetIcon } from "../downloads/SheetIcon";
import { TrimSheet } from "../downloads/TrimSheet";
import { parseSection, timecode } from "../downloads/sheetModel";
import { toolsApi, acceptsFile, type Tool, type ToolPreset } from "./api";
import {
  mediaApi,
  defaultMediaOptions,
  type MediaInfo,
  type MediaOptions,
  type MediaPlan,
  type MediaCapabilities,
} from "./mediaApi";
import { isImagePath } from "./imageApi";
import fitIcon from "../../assets/media-tools/cd126.svg?url";
import advancedIcon from "../../assets/media-tools/c80e9.svg?url";
import "../downloads/sheets.css";

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function MediaReview({
  tool,
  input,
  close,
}: {
  tool: Tool;
  input: string;
  close: () => void;
}) {
  const [path, setPath] = useState(input),
    [source, setSource] = useState(input);
  const [inspection, setInspection] = useState(0);
  const [info, setInfo] = useState<MediaInfo | null>(null),
    [plan, setPlan] = useState<MediaPlan | null>(null);
  const [presets, setPresets] = useState<ToolPreset[]>([]),
    [presetId, setPresetId] = useState(tool.presets[0]);
  const [cap, setCap] = useState(20),
    [options, setOptions] = useState(defaultMediaOptions);
  const [caps, setCaps] = useState<MediaCapabilities | null>(null),
    [probing, setProbing] = useState(false);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [estimateError, setEstimateError] = useState(""),
    [advanced, setAdvanced] = useState(false);
  const [section, setSection] = useState(false),
    [start, setStart] = useState("0:00.0"),
    [end, setEnd] = useState("");
  const [trimOptions, setTrimOptions] = useState(defaultDownloadOptions);
  const mounted = useRef(false),
    working = useRef(false);
  const sourceEpoch = useRef(0);
  const imageReviewIds = useRef(new Map<string, string>());
  const fit = tool.id === "fit-size",
    animated = tool.id === "to-gif" || tool.id === "animated-webp";
  const preset = presets.find((p) => p.id === presetId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void toolsApi
      .presets()
      .then((value) => {
        if (active) {
          setPresets(value);
          setCap(value.find((p) => p.id === tool.presets[0])?.maxMb ?? 20);
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    if (fit || tool.id === "animated-webp")
      void mediaApi
        .capabilities()
        .then((value) => {
          if (active) setCaps((old) => (old?.checked ? old : value));
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    return () => {
      active = false;
    };
  }, [tool, fit]);
  useEffect(() => {
    let active = true;
    setInfo(null);
    setPlan(null);
    setError("");
    setLoading(false);
    if (!source) return;
    if (!acceptsFile(tool, source)) {
      setError("Choose a supported audio or video file.");
      return;
    }
    if (["fit-size", "strip-metadata"].includes(tool.id) && isImagePath(source)) {
      let id = imageReviewIds.current.get(source);
      if (!id) {
        id = crypto.randomUUID();
        imageReviewIds.current.set(source, id);
      }
      setLoading(true);
      void mediaApi
        .open({ id, toolId: tool.id, input: source, inputs: [source] })
        .catch((e) => {
          if (active) setError(message(e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
      return () => {
        active = false;
      };
    }
    setLoading(true);
    void mediaApi
      .inspect(source)
      .then((value) => {
        if (active) {
          setInfo(value);
          setEnd(timecode(value.durationMs));
          setStart("0:00.0");
          setSection(false);
          setTrimOptions(defaultDownloadOptions());
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [source, tool, inspection]);
  const within = (n: number, min: number, max: number) =>
    Number.isInteger(n) && n >= min && n <= max;
  const optionError =
    (fit && !within(cap, 1, 100000)) ||
    (options.audioKbps !== null && !within(options.audioKbps, 16, 320)) ||
    !within(options.gifFps, 1, 15) ||
    !within(options.gifPixels, 32, 720)
      ? "Enter numbers within the displayed limits."
      : "";
  let selectedOptions: MediaOptions = options,
    rangeError = "";
  if (section && info) {
    try {
      selectedOptions = { ...options, trim: parseSection(start, end, info.durationMs) };
    } catch (e) {
      rangeError = message(e);
    }
  }
  const rangeStart = selectedOptions.trim?.startMs,
    rangeEnd = selectedOptions.trim?.endMs;
  useEffect(() => {
    let active = true;
    setPlan(null);
    setEstimateError("");
    if (fit && info && !rangeError && !optionError) {
      const next = {
        ...options,
        trim:
          rangeStart != null && rangeEnd != null ? { startMs: rangeStart, endMs: rangeEnd } : null,
      };
      void mediaApi
        .estimate(info, next, cap)
        .then((value) => {
          if (active) setPlan(value);
        })
        .catch((e) => {
          if (active) setEstimateError(message(e));
        });
    }
    return () => {
      active = false;
    };
  }, [fit, info, options, cap, rangeStart, rangeEnd, rangeError, optionError]);
  const patch = (change: Partial<MediaOptions>) => setOptions((value) => ({ ...value, ...change }));
  const loadSource = (value: string) => {
    sourceEpoch.current++;
    setInfo(null);
    setPlan(null);
    patch({ mode: "exact" });
    setSource(value);
    setInspection((version) => version + 1);
  };
  const submit = async (next = selectedOptions) => {
    if (
      working.current ||
      !info ||
      !preset ||
      path !== source ||
      rangeError ||
      estimateError ||
      optionError
    )
      return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      if (fit) await toolsApi.savePreset({ ...preset, maxMb: cap });
      await mediaApi.start(tool.id, source, presetId, { ...next, maxMb: fit ? cap : null });
      if (mounted.current) close();
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const fast = async () => {
    if (probing || busy) return;
    if (!info?.video) {
      patch({ mode: "exact" });
      return;
    }
    if (caps?.checked) {
      if (caps.selected) patch({ mode: "fast" });
      return;
    }
    setProbing(true);
    setError("");
    const epoch = sourceEpoch.current;
    try {
      const value = await mediaApi.capabilities(true);
      if (mounted.current) {
        setCaps(value);
        if (value.selected && sourceEpoch.current === epoch) patch({ mode: "fast" });
      }
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setProbing(false);
    }
  };
  const unavailable = tool.id === "animated-webp" && !caps?.webp;
  const disabled =
    busy ||
    loading ||
    probing ||
    !info ||
    !preset ||
    path !== source ||
    !!rangeError ||
    !!estimateError ||
    !!optionError ||
    unavailable ||
    (fit && !plan);
  const primary = fit ? `Fit under ${cap} MB` : tool.name;
  const subtitle = info
    ? `${basename(source)} · ${megabytes(info.bytes)} · ${timecode(info.durationMs)}${info.video ? ` · ${info.width} × ${info.height}` : ""}`
    : loading
      ? "Reading local media…"
      : "Choose a local audio or video file";
  return (
    <section
      className="media-review"
      aria-label={`${tool.name} options`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) close();
      }}
    >
      <header className="media-header" data-tauri-drag-region>
        <div>
          <h1>{tool.name}</h1>
          <p title={subtitle}>{subtitle}</p>
        </div>
        <IconButton label="Close media review" disabled={busy} onClick={close}>
          <SheetIcon name="close" />
        </IconButton>
      </header>
      <div className="media-body">
        {(!input || !info) && (
          <div className="media-source">
            <Field
              label="File path"
              value={path}
              disabled={busy}
              onChange={(e) => setPath(e.target.value)}
            />
            <div className="media-chips">
              <Button
                size="sm"
                disabled={busy || loading || !path || (path === source && !!info)}
                onClick={() => loadSource(path)}
              >
                Load file
              </Button>
              <Button
                size="sm"
                disabled={busy || loading}
                onClick={() => {
                  void toolsApi
                    .pick(tool.id)
                    .then((value) => {
                      if (mounted.current && value) {
                        setPath(value);
                        loadSource(value);
                      }
                    })
                    .catch((e) => {
                      if (mounted.current) setError(message(e));
                    });
                }}
              >
                Choose file…
              </Button>
            </div>
          </div>
        )}
        {fit && (
          <>
            <section>
              <h2>TARGET</h2>
              <div className="media-chips">
                {["discord", "email", "whatsapp", "custom-fit"].map((id) => {
                  const p = presets.find((p) => p.id === id);
                  return (
                    <PresetChip
                      key={id}
                      meta={id === "custom-fit" ? undefined : `${p?.maxMb ?? "…"} MB`}
                      selected={presetId === id}
                      disabled={busy}
                      onClick={() => {
                        setPresetId(id);
                        setCap(p?.maxMb ?? 20);
                      }}
                    >
                      {id === "custom-fit"
                        ? "Custom…"
                        : id === "discord"
                          ? "Discord"
                          : id === "email"
                            ? "Email"
                            : "WhatsApp"}
                    </PresetChip>
                  );
                })}
              </div>
              <p className="media-caption">Limits change. Edit the numbers in Settings → Files.</p>
              {presetId === "custom-fit" && (
                <Field
                  label="Maximum size (MB)"
                  type="number"
                  min={1}
                  max={100000}
                  value={Number.isFinite(cap) ? cap : ""}
                  disabled={busy}
                  onChange={(e) => setCap(e.target.valueAsNumber)}
                />
              )}
            </section>
            <section>
              <h2>MODE</h2>
              <div className="media-chips">
                <PresetChip
                  selected={options.mode === "exact"}
                  disabled={busy || probing}
                  onClick={() => patch({ mode: "exact" })}
                >
                  {info && !info.video ? "Exact size · audio" : "Exact size · 2 passes"}
                </PresetChip>
                <PresetChip
                  selected={options.mode === "fast"}
                  disabled={busy || probing || !info?.video || (!!caps?.checked && !caps.selected)}
                  onClick={() => {
                    void fast();
                  }}
                >
                  {probing
                    ? "Testing GPU…"
                    : `Fast · GPU${caps?.selected ? ` (${caps.selected})` : ""}`}
                </PresetChip>
              </div>
              {caps?.checked && !caps.selected && (
                <p className="media-caption">
                  No GPU encoder passed its test. Exact size uses the CPU.
                </p>
              )}
            </section>
            <dl className="media-estimate" aria-label="Estimated output">
              <div>
                <dt>Video</dt>
                <dd>
                  {plan
                    ? info?.video
                      ? `${plan.width} × ${plan.height} · ${plan.videoKbps} kb/s`
                      : "Audio only"
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Audio</dt>
                <dd>
                  {plan
                    ? plan.audioKbps
                      ? `AAC · ${plan.audioKbps} kb/s${plan.mono ? " · mono" : ""}`
                      : "None"
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd>{plan ? `≈ ${megabytes(plan.estimatedBytes)} · under ${cap} MB` : "—"}</dd>
              </div>
            </dl>
            <Toggle
              label="Downscale if needed"
              description="Only when compression alone isn’t enough"
              checked={options.downscale}
              onChange={(downscale) => patch({ downscale })}
              disabled={busy || !info?.video}
            />
          </>
        )}
        {tool.id !== "trim-video" && (
          <>
            {(fit || tool.id === "to-mp4") && (
              <Toggle
                label="Keep audio"
                checked={options.keepAudio}
                onChange={(keepAudio) => patch({ keepAudio })}
                disabled={busy || !info?.audio}
              />
            )}
            {tool.id === "to-mp4" && (
              <p className="media-caption">
                Tries a lossless remux first. If the streams cannot be copied into MP4, converts to
                H.264 and AAC.
              </p>
            )}
            {animated && (
              <p className="media-caption">
                Up to 720 pixels and 15 fps. GIFs can be large; choose a short section or animated
                WebP for smaller files.
              </p>
            )}
            {unavailable && (
              <p role="status">
                {caps
                  ? "The bundled engine has no animated WebP encoder."
                  : "Checking animated WebP support…"}
              </p>
            )}
            {tool.id === "strip-metadata" && (
              <p className="media-caption">
                Removes media tags and chapters without re-encoding. Visible information in the
                picture or sound is kept. Physical file dates are preserved.
              </p>
            )}
            <details
              className="media-advanced"
              open={advanced}
              onToggle={(e) => setAdvanced(e.currentTarget.open)}
            >
              <summary>
                <DesignIcon
                  asset={{
                    src: advancedIcon,
                    file: "media-tools/c80e9.svg",
                    width: 14,
                    height: 14,
                  }}
                />
                {fit ? "Advanced: trim, audio bitrate, max resolution, encoder" : "Advanced"}
              </summary>
              <div>
                {fit && (
                  <>
                    {presetId !== "custom-fit" && (
                      <Field
                        label="Maximum size (MB)"
                        type="number"
                        min={1}
                        max={100000}
                        value={Number.isFinite(cap) ? cap : ""}
                        disabled={busy}
                        onChange={(e) => setCap(e.target.valueAsNumber)}
                      />
                    )}
                    <Button
                      size="sm"
                      onClick={() => {
                        setPresetId("outlook");
                        setCap(presets.find((p) => p.id === "outlook")?.maxMb ?? 10);
                      }}
                      disabled={busy}
                    >
                      Use Outlook preset
                    </Button>
                    <label>
                      Maximum height
                      <select
                        value={options.maxHeight}
                        disabled={busy || !info?.video}
                        onChange={(e) => patch({ maxHeight: Number(e.target.value) })}
                      >
                        {[1080, 720, 480].map((n) => (
                          <option key={n} value={n}>
                            {n}p
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="media-caption">
                      Encoder:{" "}
                      {options.mode === "exact"
                        ? info?.video === false
                          ? "AAC"
                          : "libx264 · 2 passes"
                        : (caps?.selected ?? "Test a GPU first")}
                      . Each retry starts from the original; at most three tries.
                    </p>
                  </>
                )}
                {(fit || tool.id.startsWith("extract-")) && (
                  <Field
                    label="Audio bitrate (kb/s)"
                    description="Leave empty for automatic"
                    type="number"
                    min={16}
                    max={320}
                    value={
                      options.audioKbps !== null && Number.isFinite(options.audioKbps)
                        ? options.audioKbps
                        : ""
                    }
                    disabled={busy}
                    onChange={(e) =>
                      patch({ audioKbps: e.target.value === "" ? null : e.target.valueAsNumber })
                    }
                  />
                )}
                {animated && (
                  <>
                    <Field
                      label="Frames per second"
                      type="number"
                      min={1}
                      max={15}
                      value={Number.isFinite(options.gifFps) ? options.gifFps : ""}
                      disabled={busy}
                      onChange={(e) => patch({ gifFps: e.target.valueAsNumber })}
                    />
                    <Field
                      label="Maximum pixels"
                      type="number"
                      min={32}
                      max={720}
                      value={Number.isFinite(options.gifPixels) ? options.gifPixels : ""}
                      disabled={busy}
                      onChange={(e) => patch({ gifPixels: e.target.valueAsNumber })}
                    />
                  </>
                )}
                {tool.id !== "strip-metadata" && (
                  <>
                    <Toggle
                      label="Use a section"
                      checked={section}
                      disabled={busy || !info}
                      onChange={setSection}
                    />
                    {section && (
                      <div className="media-times">
                        <Field
                          label="Start"
                          value={start}
                          disabled={busy}
                          onChange={(e) => setStart(e.target.value)}
                        />
                        <Field
                          label="End"
                          value={end}
                          disabled={busy}
                          onChange={(e) => setEnd(e.target.value)}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            </details>
          </>
        )}
        {(error || rangeError || estimateError || optionError) && (
          <p className="media-error" role="alert">
            {error || rangeError || estimateError || optionError}
          </p>
        )}
      </div>
      {tool.id === "trim-video" && info ? (
        <TrimSheet
          local
          metadata={{
            url: "",
            normalizedUrl: "",
            title: basename(source),
            duration: info.durationMs / 1000,
            isPlaylist: false,
          }}
          options={trimOptions}
          setOptions={setTrimOptions}
          busy={disabled}
          setProblem={setError}
          onKind={() => {}}
          onDownload={(value) => {
            void submit({ ...options, trim: value.sections?.[0] ?? null });
          }}
        />
      ) : (
        <footer className="media-footer">
          <span>
            {fit && source && preset
              ? `Saved as “${basename(source).replace(/\.[^.]*$/, "")} (${preset.name}).${info?.video ? "mp4" : "m4a"}” next to the original`
              : "A new file. Original kept."}
          </span>
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => {
              void submit();
            }}
          >
            {fit && (
              <DesignIcon
                asset={{ src: fitIcon, file: "media-tools/cd126.svg", width: 16, height: 16 }}
              />
            )}
            {busy ? "Adding…" : primary}
          </Button>
        </footer>
      )}
    </section>
  );
}
