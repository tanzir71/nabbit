import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { api } from "../../lib/ipc";
import { useTheme } from "../../lib/useTheme";
import { defaultDownloadOptions } from "../../lib/downloadPresets";
import type {
  AppSettings,
  DownloadOptions,
  DownloadBrowser,
  DownloadSheetIntent,
} from "../../lib/types";
import { playlistSize } from "./sheetModel";
import { sizeLabel, siteLabel } from "./model";
import { SheetIcon } from "./SheetIcon";
import { OptionsSheet } from "./OptionsSheet";
import { TrimSheet } from "./TrimSheet";
import { PlaylistSheet } from "./PlaylistSheet";
import type { SheetControls } from "./SheetCommon";
import "./sheets.css";

export default function DownloadSheetApp() {
  const [intent, setIntent] = useState<DownloadSheetIntent | null>(null),
    [settings, setSettings] = useState<AppSettings | null>(null),
    [error, setError] = useState("");
  useTheme(settings?.theme);
  useEffect(() => {
    let active = true;
    let revision = 0;
    let stop: (() => void) | undefined;
    const registration = api
      .onEvent<DownloadSheetIntent>("download:sheet", (i) => {
        if (active) {
          revision++;
          setIntent(i);
        }
      })
      .then((s) => {
        if (active) stop = s;
        else s();
      });
    void Promise.all([registration, api.getSettings()])
      .then(async ([, s]) => {
        if (!active) return;
        const i = await api.getDownloadSheet();
        if (active) {
          if (revision === 0) setIntent(i);
          setSettings(s);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (error) void api.downloadSheetReady().catch(() => undefined);
  }, [error]);
  if (error)
    return (
      <div className="download-sheet">
        <p role="alert">{error}</p>
        <Button onClick={() => void api.closeDownloadSheet()}>Close</Button>
      </div>
    );
  if (!intent || !settings)
    return (
      <div className="download-sheet" role="status">
        Loading download review…
      </div>
    );
  return <SheetSession key={intent.id} intent={intent} settings={settings} />;
}
function SheetSession({
  intent,
  settings,
}: {
  intent: DownloadSheetIntent;
  settings: AppSettings;
}) {
  const [metadata, setMetadata] = useState(intent.metadata),
    [options, setOptions] = useState({ ...defaultDownloadOptions(), ...intent.draft.options });
  const [kind, setKind] = useState(intent.draft.kind),
    [remember, setRemember] = useState(intent.draft.remember),
    [browser, setBrowser] = useState<DownloadBrowser | undefined>();
  const [busy, setBusy] = useState(false),
    [submitted, setSubmitted] = useState(false),
    [problem, setProblem] = useState("");
  const lock = useRef(false),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    if (!intent.metadata)
      void api
        .probeUrl(intent.draft.url)
        .then((m) => {
          if (active) setMetadata(m);
        })
        .catch(() => {
          if (active) {
            setMetadata({
              url: intent.draft.url,
              normalizedUrl: intent.draft.url,
              title: siteLabel(intent.draft.url),
              duration: null,
              thumbnail: null,
              isPlaylist: new URL(intent.draft.url).searchParams.has("list"),
              qualities: [],
              details: null,
              extractor: "fallback",
            });
            setProblem(
              "Video details could not be loaded. You can still choose options for this link.",
            );
          }
        });
    return () => {
      active = false;
    };
  }, [intent]);
  useEffect(() => {
    void api.downloadSheetReady().catch((e) => setProblem(String(e)));
    root.current?.focus();
  }, []);
  const close = () => {
    if (!lock.current) void api.closeDownloadSheet(intent.id).catch((e) => setProblem(String(e)));
  };
  const download = async (next: DownloadOptions = options, indices?: number[]) => {
    if (!metadata || lock.current || submitted) return;
    if (
      metadata.isPlaylist &&
      !indices &&
      (next.playlistMode === "playlist" || !new URL(metadata.normalizedUrl).searchParams.get("v"))
    ) {
      setKind("playlist");
      setOptions({
        ...options,
        ...next,
        playlistMode: "playlist",
        playlistItems: next.playlistMode === "playlist" ? (next.playlistItems ?? null) : "1",
      });
      return;
    }
    lock.current = true;
    setBusy(true);
    setProblem("");
    try {
      const request = {
        url: intent.draft.url,
        options: next,
        rememberForSite: remember,
        cookiesFromBrowser: browser,
      };
      if (indices) await api.startPlaylistDownload(request, indices);
      else await api.startDownload(request);
      setSubmitted(true);
      await api.closeDownloadSheet(intent.id);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const controls: SheetControls | null = metadata
    ? { metadata, options, setOptions, busy: busy || submitted, setProblem, onKind: setKind }
    : null;
  const playlistBytes =
    metadata?.details?.entries.length &&
    !metadata.details.truncated &&
    ["mp4", "mkv", "webm"].includes(options.format)
      ? playlistSize(metadata.details?.entries ?? [], options.height)
      : null;
  const key = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key === "Tab") {
      const nodes = [
        ...root.current!.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
        ),
      ].filter((n) => n.getClientRects().length > 0);
      if (!nodes.length) return;
      if (
        event.shiftKey &&
        (document.activeElement === nodes[0] || document.activeElement === root.current)
      ) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0].focus();
      }
    }
    // Each sheet submits through its visible primary button, including Ctrl+Enter.
    if (event.key === "Enter" && event.ctrlKey && !event.repeat && !event.nativeEvent.isComposing) {
      event.preventDefault();
      root.current?.querySelector<HTMLButtonElement>("[data-sheet-primary]")?.click();
    }
  };
  return (
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={
        kind === "options"
          ? "Download options"
          : kind === "trim"
            ? "Trim and chapters"
            : metadata?.title || "Playlist"
      }
      className={`download-sheet sheet-${kind}`}
      data-sheet={kind}
      onKeyDown={key}
    >
      <header
        className="sheet-header"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && "__TAURI_INTERNALS__" in window)
            void getCurrentWindow().startDragging();
        }}
      >
        {kind === "playlist" && (
          <span className="sheet-playlist-mark">
            <SheetIcon name="layers" />
          </span>
        )}
        <div className="sheet-heading">
          <h1>
            {kind === "options"
              ? "Download options"
              : kind === "trim"
                ? "Trim and chapters"
                : metadata?.title || "Playlist"}
          </h1>
          {kind === "playlist" && (
            <p>
              Playlist · {metadata?.playlistCount ?? metadata?.details?.entries.length ?? "Unknown"}{" "}
              videos ·{" "}
              {playlistBytes != null ? `about ${sizeLabel(playlistBytes)}` : "Size unknown"}
              {options.height ? ` at ${options.height}p` : ""}
            </p>
          )}
        </div>
        <IconButton label="Close download sheet" onClick={close} disabled={busy}>
          <SheetIcon name="close" />
        </IconButton>
      </header>
      {controls ? (
        kind === "options" ? (
          <OptionsSheet
            {...controls}
            settings={settings}
            browser={browser}
            onBrowser={setBrowser}
            onDownload={() => void download()}
            remember={remember}
            onRemember={setRemember}
          />
        ) : kind === "trim" ? (
          <TrimSheet {...controls} onDownload={(o) => void download(o)} />
        ) : (
          <PlaylistSheet {...controls} onDownload={(indices) => void download(options, indices)} />
        )
      ) : (
        <div className="sheet-body">
          <p role="status">Loading video details…</p>
        </div>
      )}
      {problem && (
        <p role="alert" className="sheet-problem">
          {problem}
        </p>
      )}
    </div>
  );
}
