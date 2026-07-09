import { AlertCircle, Download, FolderOpen, Link, Pause, Play, RefreshCcw, RotateCcw, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { IconButton } from "../components/IconButton";
import { Segmented } from "../components/Segmented";
import { api } from "../lib/ipc";
import type { DownloadJob, Quality } from "../lib/types";
import { useAppStore } from "../store/useAppStore";

const qualityOptions: Array<{ label: string; value: Quality }> = [
  { label: "Best", value: "best" },
  { label: "4K", value: "2160p" },
  { label: "1440", value: "1440p" },
  { label: "1080", value: "1080p" },
  { label: "720", value: "720p" },
  { label: "MP3", value: "audio_mp3" },
];

export function DownloadPanel() {
  const settings = useAppStore((state) => state.settings);
  const stagedUrl = useAppStore((state) => state.stagedUrl);
  const metadata = useAppStore((state) => state.metadata);
  const downloads = useAppStore((state) => state.downloads);
  const engine = useAppStore((state) => state.engine);
  const stageUrl = useAppStore((state) => state.stageUrl);
  const clearStagedUrl = useAppStore((state) => state.clearStagedUrl);
  const startDownload = useAppStore((state) => state.startDownload);
  const cancelDownload = useAppStore((state) => state.cancelDownload);
  const pauseDownload = useAppStore((state) => state.pauseDownload);
  const resumeDownload = useAppStore((state) => state.resumeDownload);
  const retryDownload = useAppStore((state) => state.retryDownload);
  const repairEngine = useAppStore((state) => state.repairEngine);
  const [input, setInput] = useState(stagedUrl);
  const [quality, setQuality] = useState<Quality>(settings?.defaultQuality ?? "1080p");
  const [playlistMode, setPlaylistMode] = useState<"video" | "playlist">("video");
  const [playlistRange, setPlaylistRange] = useState("");

  useEffect(() => {
    setInput(stagedUrl);
  }, [stagedUrl]);

  const activeJobs = useMemo(
    () => downloads.filter((job) => job.status !== "completed").slice(0, 8),
    [downloads],
  );
  const completedJobs = useMemo(
    () => downloads.filter((job) => job.status === "completed").slice(0, 6),
    [downloads],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void stageUrl(input);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 space-y-3 border-b border-slate-200 p-4 dark:border-slate-800">
        {engine?.missing.length ? (
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
            <AlertCircle size={18} />
            <span className="min-w-0 flex-1">Downloader engine needs repair: {engine.missing.join(", ")}</span>
            <Button size="sm" onClick={() => void repairEngine()}>
              <RefreshCcw size={14} />
              Repair
            </Button>
          </div>
        ) : null}

        <form onSubmit={submit} className="flex gap-2">
          <Field
            label="Video URL"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Paste a YouTube link"
            className="w-full"
          />
          <Button type="submit" className="mt-[22px]">
            <Link size={16} />
            Stage
          </Button>
        </form>

        {metadata ? (
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="flex gap-3 p-3">
              <div className="grid aspect-video w-28 shrink-0 place-items-center overflow-hidden rounded-md bg-slate-200 text-xs text-slate-500 dark:bg-slate-800">
                {metadata.thumbnail ? (
                  <img src={metadata.thumbnail} alt="" className="h-full w-full object-cover" />
                ) : (
                  "No image"
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="line-clamp-2 text-sm font-semibold">{metadata.title}</h2>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {metadata.channel ?? metadata.extractor ?? "yt-dlp"}
                  {metadata.duration ? ` - ${Math.round(metadata.duration / 60)} min` : ""}
                </p>
                {metadata.isPlaylist ? (
                  <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                    Playlist detected{metadata.playlistCount ? ` - ${metadata.playlistCount} items` : ""}
                  </p>
                ) : null}
              </div>
              <IconButton label="Clear staged link" onClick={clearStagedUrl}>
                <X size={16} />
              </IconButton>
            </div>
            <div className="grid gap-3 border-t border-slate-200 p-3 dark:border-slate-800">
              <Segmented label="Quality" value={quality} options={qualityOptions} onChange={setQuality} />
              {metadata.isPlaylist ? (
                <div className="grid grid-cols-[1fr_110px] gap-2">
                  <Segmented
                    label="Playlist mode"
                    value={playlistMode}
                    options={[
                      { label: "Video", value: "video" },
                      { label: "Playlist", value: "playlist" },
                    ]}
                    onChange={setPlaylistMode}
                  />
                  <input
                    aria-label="Playlist range"
                    disabled={playlistMode === "video"}
                    placeholder="1-10"
                    value={playlistRange}
                    onChange={(event) => setPlaylistRange(event.target.value)}
                    className="h-10 rounded-md border border-slate-200 bg-white px-2 text-sm outline-none disabled:opacity-50 dark:border-slate-800 dark:bg-slate-950"
                  />
                </div>
              ) : null}
              <Button
                variant="primary"
                onClick={() =>
                  void startDownload({
                    url: metadata.normalizedUrl,
                    quality,
                    playlistMode,
                    playlistRange: playlistRange.trim() || undefined,
                  })
                }
              >
                <Download size={16} />
                Download
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <QueueSection
          title="Queue"
          jobs={activeJobs}
          empty="Nothing downloading."
          onCancel={cancelDownload}
          onPause={pauseDownload}
          onResume={resumeDownload}
          onRetry={retryDownload}
        />
        <QueueSection
          title="History"
          jobs={completedJobs}
          empty="Finished downloads will appear here."
          onCancel={cancelDownload}
          onPause={pauseDownload}
          onResume={resumeDownload}
          onRetry={retryDownload}
        />
      </div>
    </div>
  );
}

function QueueSection({
  title,
  jobs,
  empty,
  onCancel,
  onPause,
  onResume,
  onRetry,
}: {
  title: string;
  jobs: DownloadJob[];
  empty: string;
  onCancel: (id: string) => Promise<void>;
  onPause: (id: string) => Promise<void>;
  onResume: (id: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
}) {
  return (
    <section className="mb-5 grid gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
        {title === "History" ? (
          <IconButton label="Open downloads folder" onClick={() => void api.openDownloadsFolder()}>
            <FolderOpen size={16} />
          </IconButton>
        ) : null}
      </div>
      {jobs.length === 0 ? <p className="py-4 text-sm text-slate-500">{empty}</p> : null}
      {jobs.map((job) => (
        <article
          key={job.id}
          className="grid gap-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium">{job.title}</h3>
              <p className="text-xs capitalize text-slate-500">{job.status.replace("_", " ")}</p>
            </div>
            {job.status === "failed" || job.status === "cancelled" ? (
              <IconButton label="Retry" onClick={() => void onRetry(job.id)}>
                <RotateCcw size={16} />
              </IconButton>
            ) : null}
            {job.status === "paused" || job.status === "interrupted" ? (
              <IconButton label="Resume" onClick={() => void onResume(job.id)}>
                <Play size={16} />
              </IconButton>
            ) : null}
            {job.status === "running" || job.status === "queued" ? (
              <IconButton label="Pause" onClick={() => void onPause(job.id)}>
                <Pause size={16} />
              </IconButton>
            ) : null}
            {job.status === "running" || job.status === "queued" ? (
              <IconButton label="Cancel" onClick={() => void onCancel(job.id)}>
                <X size={16} />
              </IconButton>
            ) : null}
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
            />
          </div>
          <p className="truncate text-xs text-slate-500">
            {Math.round(job.progress)}% {job.speed ? `- ${job.speed}` : ""} {job.eta ? `- ETA ${job.eta}` : ""}
            {job.error ? ` - ${job.error}` : ""}
          </p>
        </article>
      ))}
    </section>
  );
}
