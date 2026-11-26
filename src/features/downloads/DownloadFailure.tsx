import { useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Select } from "../../components/Select";
import { Field } from "../../components/Field";
import { DesignIcon } from "../../components/DesignIcon";
import { api } from "../../lib/ipc";
import type {
  DownloadJob,
  DownloadBrowser,
  DownloadErrorAction,
  DownloadFailure as Failure,
} from "../../lib/types";
import { useAppStore } from "../../store/useAppStore";
import "./errors.css";

const svgs = import.meta.glob<string>("../../assets/download-errors/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
});
const icon = (name: string, width: number) => (
  <DesignIcon
    asset={{
      src: svgs[`../../assets/download-errors/${name}.svg`],
      file: `download-errors/${name}.svg`,
      width,
      height: width,
    }}
  />
);
const kinds: Record<Failure["kind"], [string, string]> = {
  SignInRequired: ["4c9d0", "Sign-in required"],
  SiteChanged: ["ee21d", "Site changed"],
  MissingJsRuntime: ["e8c4c", "Missing JS runtime"],
  FormatUnavailable: ["1ddbc", "Format unavailable"],
  Drm: ["ba187", "DRM-protected"],
  Disk: ["f01e4", "Disk or folder"],
  Offline: ["a92d4", "Offline"],
  Live: ["2984a", "Live stream"],
  Unknown: ["ee21d", "Download failed"],
};
const unknown: Failure = {
  kind: "Unknown",
  title: "Download failed",
  description:
    "The downloader could not finish this item. Retry, or copy the details to investigate.",
  actions: ["retry", "copyDetails"],
};

export function DownloadFailure({ job }: { job: DownloadJob }) {
  const failure = job.failure ?? unknown;
  const [browser, setBrowser] = useState<DownloadBrowser>("chrome"),
    [folder, setFolder] = useState(job.options?.outputDir ?? ""),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [dismissed, setDismissed] = useState(false);
  const lock = useRef(false);
  const perform = async (action: DownloadErrorAction) => {
    if (lock.current) return;
    if (action === "chooseFolder" && !editing) {
      setEditing(true);
      return;
    }
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (action === "copyDetails") {
        await api.copyDownloadDetails(job.id);
        setMessage("Details copied.");
      } else if (action === "choose")
        await api.openDownloadSheet({
          kind: "options",
          url: job.url,
          options: job.options ?? {},
          remember: false,
          retryJobId: job.id,
        });
      else if (action === "dismiss") {
        await api.dismissDownloadProblem(job.id);
        setDismissed(true);
      } else if (action === "updateEngine" || action === "installDeno") {
        const status = await api.repairEngine();
        if (status.busy || status.updateError || status.missing.length || status.failure)
          setMessage("The engine still needs attention. Open Engine health to check its status.");
        else {
          await api.retryDownload(job.id);
          await useAppStore.getState().refreshDownloads();
          setMessage("Engine ready. Retrying this download.");
        }
      } else {
        if (action === "cancel") await api.cancelDownload(job.id);
        else if (action === "retry") await api.retryDownload(job.id);
        else if (action === "signIn") await api.retryDownloadWithBrowser(job.id, browser);
        else
          await api.recoverDownload(
            job.id,
            action === "chooseFolder" ? { kind: "folder", outputDir: folder } : { kind: action },
          );
        await useAppStore.getState().refreshDownloads();
      }
    } catch {
      setMessage("That action could not finish. Try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  if (dismissed)
    return (
      <div className="download-failure-dismissed">
        <span>{failure.title}</span>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(false)}>
          Show fix
        </Button>
      </div>
    );
  const browserLabel = browser[0].toUpperCase() + browser.slice(1);
  const label = (action: DownloadErrorAction): string =>
    ({
      signIn: `Use ${browserLabel} sign-in`,
      retry: "Retry",
      updateEngine: "Update engine",
      copyDetails: "Copy details",
      installDeno: "Install Deno",
      dismiss: failure.kind === "Drm" ? "OK" : "Skip for now",
      bestAvailable: "Use best available",
      choose: "Choose…",
      chooseFolder: editing ? "Save and retry" : "Choose folder",
      cancel: "Cancel",
      waitForVideo: "Download when it ends",
    })[action];
  const neutral = ["Drm", "Offline", "Live"].includes(failure.kind);
  return (
    <section
      className={`download-failure is-${failure.kind} ${neutral ? "is-neutral" : ""}`}
      aria-label={`Problem with ${job.title}`}
      aria-busy={busy}
    >
      <div className="download-failure-kind">
        {icon(kinds[failure.kind][0], 16)}
        <span>{kinds[failure.kind][1]}</span>
      </div>
      <div className="download-failure-message">
        <h4>
          {icon(
            failure.kind === "Offline" || failure.kind === "Live"
              ? "48f16"
              : failure.kind === "Drm"
                ? "8fce1"
                : "18902",
            14,
          )}
          {failure.title}
        </h4>
        <p>{failure.description}</p>
      </div>
      {failure.kind === "SignInRequired" && (
        <Select
          label="Browser sign-in"
          value={browser}
          disabled={busy}
          onChange={(event) => setBrowser(event.target.value as DownloadBrowser)}
        >
          {["chrome", "edge", "firefox", "brave"].map((name) => (
            <option key={name} value={name}>
              {name[0].toUpperCase() + name.slice(1)}
            </option>
          ))}
        </Select>
      )}
      {editing && (
        <Field
          label="Save this download to"
          autoFocus
          value={folder}
          disabled={busy}
          onChange={(event) => setFolder(event.target.value)}
        />
      )}
      {job.options?.waitForVideo && failure.kind === "Live" && (
        <p role="status">Waiting for the replay. You can cancel at any time.</p>
      )}
      <div className="download-failure-actions">
        {failure.actions.map((action, index) => (
          <Button
            key={action}
            size="sm"
            variant={index === 0 && failure.actions.length > 1 ? "secondary" : "ghost"}
            disabled={
              busy ||
              (action === "chooseFolder" && editing && !folder.trim()) ||
              (action === "waitForVideo" && job.options?.waitForVideo === true)
            }
            onClick={() => void perform(action)}
          >
            {label(action)}
          </Button>
        ))}
      </div>
      {message && (
        <p role="status" className="download-failure-status">
          {message}
        </p>
      )}
    </section>
  );
}
