import { useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { ProgressRing } from "../../components/ProgressRing";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { api } from "../../lib/ipc";
import type { DownloadJob } from "../../lib/types";
import { useAppStore } from "../../store/useAppStore";
import { DownloadIcon } from "./DownloadIcon";
import { formatLabel, jobSummary, terminal } from "./model";
export function DownloadQueue({
  island = false,
  query = "",
}: {
  island?: boolean;
  query?: string;
}) {
  const jobs = useAppStore((s) => s.downloads),
    refresh = useAppStore((s) => s.refreshDownloads);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const visible = jobs.filter((j) =>
    `${j.title} ${j.url}`.toLowerCase().includes(query.toLowerCase()),
  );
  const clear = async () => {
    setBusy(true);
    setError("");
    try {
      await api.clearFinishedDownloads();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className={`nab-queue ${island ? "is-island" : "is-tray"}`}
      aria-label="Download queue"
    >
      {!island && (
        <div className="nab-queue-heading">
          <h2>Queue</h2>
          <Badge>{jobs.length}</Badge>
          <span className="nab-spacer" />
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !jobs.some(terminal)}
            onClick={() => void clear()}
          >
            Clear finished
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="nab-error">
          {error}
        </p>
      )}
      {visible.length === 0 && (
        <p className="nab-empty">{query ? "No matching downloads." : "Your queue is empty."}</p>
      )}
      <div className="nab-queue-list">
        {visible.map((job) => (
          <QueueRow key={job.id} job={job} island={island} />
        ))}
      </div>
    </section>
  );
}
function QueueRow({ job, island }: { job: DownloadJob; island: boolean }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [menu, setMenu] = useState(false);
  const store = useAppStore;
  const running = job.status === "running" || job.status === "queued";
  const resumable = job.status === "paused" || job.status === "interrupted";
  const retryable = job.status === "failed" || job.status === "cancelled";
  const action = async (
    name: "pause" | "cancel" | "resume" | "retry" | "open" | "reveal" | "signIn",
  ) => {
    setBusy(true);
    setError("");
    setMenu(false);
    try {
      if (name === "signIn") {
        await api.retryDownloadWithBrowser(job.id, "chrome");
        await store.getState().refreshDownloads();
      } else if (name === "open") await api.openDownload(job.id);
      else if (name === "reveal") await api.revealDownload(job.id);
      else await store.getState()[`${name}Download`](job.id);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const control = (name: "pause" | "cancel" | "resume" | "reveal", label: string) => (
    <IconButton
      size={28}
      disabled={busy}
      label={`${label}: ${job.title}`}
      onClick={() => void action(name)}
    >
      {name === "resume" ? <DownloadIcon name="retry" /> : <DownloadIcon name={name} />}
    </IconButton>
  );
  const failedCopy =
    job.error
      ?.split(/\r?\n/)
      .find((line) => line.trim().startsWith("ERROR:"))
      ?.replace(/^\s*ERROR:\s*/, "") ||
    (job.error?.includes("\n") ? "The downloader could not finish this item." : job.error) ||
    "The downloader could not finish this item.";
  return (
    <article
      className={`nab-queue-row is-${job.status}`}
      aria-label={`${job.title}, ${job.status}`}
      tabIndex={island ? 0 : undefined}
      onContextMenu={
        island
          ? (e) => {
              e.preventDefault();
              setMenu(true);
            }
          : undefined
      }
      onKeyDownCapture={(e) => {
        if (e.key === "Escape" && menu) {
          e.preventDefault();
          e.stopPropagation();
          setMenu(false);
        }
        if (island && e.shiftKey && e.key === "F10") {
          e.preventDefault();
          setMenu(true);
        }
      }}
    >
      <div className="nab-job-top">
        {island && job.status !== "completed" && job.status !== "failed" ? (
          <ProgressRing
            value={job.status === "running" ? job.progress : 0}
            size={18}
            label={`${Math.round(job.progress)}%`}
          />
        ) : (
          <span className={`nab-job-icon ${job.status === "completed" ? "is-done" : ""}`}>
            <DownloadIcon
              name={
                job.status === "completed" ? "done" : job.status === "failed" ? "failed" : "running"
              }
            />
          </span>
        )}
        <div className="nab-job-text">
          <h3 title={job.title}>{job.title}</h3>
          {!island && (
            <p
              className={job.status === "failed" ? "nab-error" : running ? "nab-job-progress" : ""}
            >
              {job.status === "failed" ? failedCopy.slice(0, 180) : jobSummary(job)}
            </p>
          )}
        </div>
        {island && (
          <span className="nab-job-summary">
            {job.status === "running"
              ? [`${Math.round(job.progress)}%`, job.speed, formatLabel(job)]
                  .filter(Boolean)
                  .join(" · ")
              : jobSummary(job)}
          </span>
        )}
        {island ? (
          <>
            {job.status === "running" && (
              <IconButton
                size={28}
                variant="island"
                className="nab-island-control"
                label={`Pause: ${job.title}`}
                disabled={busy}
                onClick={() => void action("pause")}
              >
                <IslandAsset group="9:78" name="iconPause" />
              </IconButton>
            )}
            {job.status === "completed" && (
              <Button
                size="sm"
                disabled={busy || !job.outputPath}
                onClick={() => void action("open")}
              >
                Open
              </Button>
            )}
            <IconButton
              size={28}
              variant="island"
              className={`nab-island-control ${job.status === "running" ? "nab-row-more" : ""}`}
              label={`Download actions: ${job.title}`}
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <IslandAsset group="9:78" name="iconEllipsis1" />
            </IconButton>
          </>
        ) : (
          <>
            {running && (
              <>
                {control("pause", "Pause")}
                {control("cancel", "Cancel")}
              </>
            )}
            {resumable && (
              <>
                {control("resume", "Resume")}
                {control("cancel", "Cancel")}
              </>
            )}
            {job.status === "completed" && (
              <>
                <Button
                  size="sm"
                  disabled={busy || !job.outputPath}
                  onClick={() => void action("open")}
                >
                  Open
                </Button>
                {control("reveal", "Reveal")}
              </>
            )}
          </>
        )}
      </div>
      {!island && running && (
        <div
          className="nab-job-track"
          role="progressbar"
          aria-label={`Progress: ${job.title}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.max(0, Math.min(100, job.progress)))}
        >
          <i style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
        </div>
      )}
      {!island && retryable && (
        <div className="nab-job-fix">
          {job.status === "failed" &&
            /sign(?:ed)?[\s-]*in|members.only|age.restrict/i.test(job.error ?? "") && (
              <Button size="sm" disabled={busy} onClick={() => void action("signIn")}>
                <DownloadIcon name="signIn" />
                Use Chrome sign-in
              </Button>
            )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void action("retry")}>
            <DownloadIcon name="retry" />
            Retry
          </Button>
          <span className="nab-spacer" />
          <details>
            <summary>Why?</summary>
            <p>The downloader could not finish this item. Retry or check the download engine.</p>
          </details>
        </div>
      )}
      {menu && (
        <div role="menu" className="nab-job-menu" aria-label={`Actions for ${job.title}`}>
          {running && (
            <button role="menuitem" disabled={busy} onClick={() => void action("pause")}>
              Pause
            </button>
          )}
          {resumable && (
            <button role="menuitem" disabled={busy} onClick={() => void action("resume")}>
              Resume
            </button>
          )}
          {(running || resumable) && (
            <button role="menuitem" disabled={busy} onClick={() => void action("cancel")}>
              Cancel
            </button>
          )}
          {retryable && (
            <button role="menuitem" disabled={busy} onClick={() => void action("retry")}>
              Retry
            </button>
          )}
          {job.status === "completed" && (
            <>
              <button
                role="menuitem"
                disabled={busy || !job.outputPath}
                onClick={() => void action("open")}
              >
                Open
              </button>
              <button
                role="menuitem"
                disabled={busy || !job.outputPath}
                onClick={() => void action("reveal")}
              >
                Reveal
              </button>
            </>
          )}
          <button role="menuitem" onClick={() => setMenu(false)}>
            Close menu
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="nab-error">
          {error}
        </p>
      )}
    </article>
  );
}
