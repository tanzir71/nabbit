import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { DesignIcon } from "../components/DesignIcon";
import { useEngineHealth } from "../lib/useEngineHealth";
import cpu from "../assets/engine/cpu.svg";
import check from "../assets/engine/check.svg";
import refresh from "../assets/engine/refresh.svg";
import "./engine-health.css";
const icons = {
  cpu: { src: cpu, file: "engine/cpu.svg", width: 18, height: 18 },
  check: { src: check, file: "engine/check.svg", width: 16, height: 16 },
  refresh: { src: refresh, file: "engine/refresh.svg", width: 16, height: 16 },
};

function age(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "not checked yet";
  const hours = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 3_600_000));
  return hours < 1
    ? "just now"
    : hours < 24
      ? `${hours} hour${hours === 1 ? "" : "s"} ago`
      : `${Math.floor(hours / 24)} day${hours < 48 ? "" : "s"} ago`;
}
export function EngineHealthCard() {
  const { status, busy, error, run } = useEngineHealth();
  const channel = status?.channel ?? "stable";
  const attention = Boolean(status?.failure || status?.missing.length);
  const ready = Boolean(status?.checkedAt);
  const extraction = status?.extraction;
  const rows = [
    {
      name: "yt-dlp",
      version: status?.ytdlpVersion,
      detail: `${channel === "nightly" ? "Nightly" : "Stable"} channel · ${status?.updatedAt ? `updated ${age(status.updatedAt)}` : "bundled engine"}`,
    },
    {
      name: "Deno",
      version: status?.denoVersion,
      detail: "JavaScript runtime yt-dlp needs for YouTube",
    },
    { name: "ffmpeg", version: status?.ffmpegVersion, detail: "Merging and audio conversion" },
    {
      name: "Test extraction",
      version:
        extraction?.result === "passed"
          ? "Passed"
          : extraction?.result === "failed"
            ? "Failed"
            : extraction?.result === "skipped"
              ? "Skipped"
              : "Not run",
      detail:
        extraction?.result === "passed"
          ? `Ran ${age(extraction.checkedAt)} on a Creative Commons sample`
          : extraction?.detail || "A 3-second check on a Creative Commons sample",
      test: true,
    },
  ];
  return (
    <section className="engine-health" aria-label="Download engine health" aria-busy={busy}>
      <header className="engine-health-header">
        <DesignIcon asset={icons.cpu} />
        <h3>Download engine</h3>
        <Badge tone={attention ? "warning" : ready ? "signal" : "neutral"}>
          {busy
            ? "Checking…"
            : attention
              ? "Needs attention"
              : ready
                ? extraction?.result === "passed"
                  ? "Healthy"
                  : "Ready"
                : "Not checked"}
        </Badge>
      </header>
      {rows.map((row) => {
        const good = row.test ? extraction?.result === "passed" : Boolean(row.version);
        return (
          <div className="engine-health-row" key={row.name}>
            {good ? (
              <DesignIcon asset={icons.check} />
            ) : (
              <span className="engine-health-indicator" aria-hidden="true">
                {ready ? "!" : "·"}
              </span>
            )}
            <div className="engine-health-text">
              <strong>{row.name}</strong>
              <p>{row.detail}</p>
            </div>
            <span className="engine-health-version">
              {row.version ?? (ready ? "Missing" : "—")}
            </span>
          </div>
        );
      })}
      <div className="engine-health-actions">
        <Button size="sm" disabled={busy} onClick={() => void run("check")}>
          <DesignIcon asset={icons.refresh} />
          Check now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void run("update", channel === "stable" ? "nightly" : "stable")}
        >
          Use {channel === "stable" ? "nightly" : "stable"}
        </Button>
        {(attention || status?.updateError) && (
          <Button size="sm" disabled={busy} onClick={() => void run("update")}>
            Repair engine
          </Button>
        )}
      </div>
      {(error || status?.updateError) && (
        <p className="engine-health-error" role="alert">
          {error || status?.updateError}
        </p>
      )}
      <p className="engine-health-caption">
        Daily background check: version probe plus a 3-second test extraction. Failures surface as
        one island state, “Download engine needs an update — Fix”.
      </p>
      <span className="sr-only" role="status">
        {busy
          ? "Checking download engine"
          : ready
            ? `Engine checked ${age(status?.checkedAt)}`
            : "Engine health has not been checked"}
      </span>
    </section>
  );
}
