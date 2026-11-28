import { useSettings } from "./context";
import { lazy, Suspense, useState } from "react";
import { version } from "../../../package.json";
import privacyStatement from "../../../PRIVACY.md?raw";
import { Button } from "../../components/Button";
import { useAppStore } from "../../store/useAppStore";
import { api } from "../../lib/ipc";
import { EngineHealthCard } from "../../views/EngineHealthCard";
import {
  SettingsChoices,
  SettingsField,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "./SettingsControls";
const FilesSettings = lazy(() => import("../tools/FilesSettings"));
const Licenses = lazy(() => import("../tools/Licenses"));
const Pins = lazy(() => import("../files/Pins").then((m) => ({ default: m.Pins })));
const TackSettings = lazy(() =>
  import("../notes/TackSettings").then((m) => ({ default: m.TackSettings })),
);

export function DownloadsSettings() {
  const { settings } = useSettings();
  return (
    <>
      <SettingsSection title="New downloads">
        <SettingsChoices
          label="Default quality"
          value={settings.defaultQuality}
          options={[
            { label: "Best", value: "best" },
            { label: "1080p", value: "1080p" },
            { label: "720p", value: "720p" },
            { label: "MP3", value: "audio_mp3" },
          ]}
          change={(defaultQuality) => ({ defaultQuality })}
        />
        <SettingsField
          label="Output folder"
          value={settings.outputDir}
          placeholder="Use Downloads/Nabbit"
          change={(outputDir) => ({ outputDir })}
        />
        <SettingsField
          label="Filename template"
          value={settings.filenameTemplate}
          change={(filenameTemplate) => ({ filenameTemplate })}
        />
        <SettingsField
          label="Max concurrent downloads"
          value={settings.maxConcurrentDownloads}
          min={1}
          max={6}
          change={(value) => ({ maxConcurrentDownloads: Number(value) })}
        />
        <SettingsToggle
          label="Reveal after download"
          checked={settings.revealAfterDownload}
          change={(revealAfterDownload) => ({ revealAfterDownload })}
        />
      </SettingsSection>
      <SettingsSection title="Downloader engine">
        <SettingsToggle
          label="Keep downloader engine up to date"
          checked={settings.engineAutoUpdate}
          change={(engineAutoUpdate) => ({ engineAutoUpdate })}
        />
      </SettingsSection>
      <EngineHealthCard />
    </>
  );
}
export function ClipboardSettings() {
  const { settings } = useSettings();
  const stats = useAppStore((s) => s.stats),
    clear = useAppStore((s) => s.clearHistory);
  const [confirm, setConfirm] = useState(false),
    [clearing, setClearing] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <SettingsSection title="History">
        <SettingsChoices
          label="Retention"
          value={settings.retentionDays}
          options={[
            { label: "30 days", value: 30 },
            { label: "60 days", value: 60 },
            { label: "90 days", value: 90 },
          ]}
          change={(retentionDays) => ({ retentionDays })}
        />
        <SettingsToggle
          label="Capture images"
          help="Stores safe thumbnails locally"
          checked={settings.captureImages}
          change={(captureImages) => ({ captureImages })}
        />
        <SettingsField
          label="Image cap (MB)"
          value={settings.imageSizeCapMb}
          min={1}
          max={50}
          change={(value) => ({ imageSizeCapMb: Number(value) })}
        />
        <SettingsToggle
          label="Paste on select"
          checked={settings.pasteOnSelect}
          change={(pasteOnSelect) => ({ pasteOnSelect })}
        />
        <SettingsToggle
          label="Sensitive text heuristics"
          help="Skips likely OTPs, cards and long high-entropy secrets"
          checked={settings.sensitiveHeuristics}
          change={(sensitiveHeuristics) => ({ sensitiveHeuristics })}
        />
      </SettingsSection>
      <SettingsSection title="Link detection">
        <SettingsToggle
          label="Pause clipboard capture"
          help="Stops new history and automatic link detection until resumed"
          checked={settings.pauseClipboardCapture}
          change={(pauseClipboardCapture) => ({ pauseClipboardCapture })}
        />
        <SettingsToggle
          label="Auto-detect video links"
          checked={settings.autoDetectLinks}
          change={(autoDetectLinks) => ({ autoDetectLinks })}
        />
        <SettingsToggle
          label="Show detected-link notification"
          checked={settings.showDetectNotification}
          change={(showDetectNotification) => ({ showDetectNotification })}
        />
        <SettingsToggle
          label="Pause auto-detect"
          checked={settings.pauseAutoDetect}
          change={(pauseAutoDetect) => ({ pauseAutoDetect })}
        />
      </SettingsSection>
      <SettingsSection title="Storage">
        <SettingsRow
          title={`${stats?.clipboardCount ?? 0} clipboard items · ${stats?.downloadCount ?? 0} downloads`}
          help={
            stats
              ? `${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB on disk`
              : "Storage counts unavailable"
          }
        >
          <Button size="sm" variant="danger" disabled={clearing} onClick={() => setConfirm(true)}>
            Clear clipboard history
          </Button>
        </SettingsRow>
        {confirm && (
          <div
            className="settings-confirm"
            role="group"
            aria-label="Confirm clearing clipboard history"
          >
            <p>This permanently removes clipboard history. Downloads and notes are kept.</p>
            <Button
              variant="danger"
              size="sm"
              disabled={clearing}
              onClick={async () => {
                setClearing(true);
                setError("");
                try {
                  await clear();
                  setConfirm(false);
                } catch (reason) {
                  setError(String(reason));
                } finally {
                  setClearing(false);
                }
              }}
            >
              Clear history
            </Button>
            <Button variant="ghost" size="sm" disabled={clearing} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="settings-message">
            {error}
          </p>
        )}
      </SettingsSection>
    </>
  );
}
export function NotesSettings() {
  return (
    <SettingsSection title="Notes & Tack" card={false}>
      <Suspense fallback={<p role="status">Loading notes settings…</p>}>
        <TackSettings />
      </Suspense>
    </SettingsSection>
  );
}
export function FilesPreferences() {
  return (
    <>
      <SettingsSection title="Pinned files and folders" card={false}>
        <Suspense fallback={<p role="status">Loading pins…</p>}>
          <Pins />
        </Suspense>
      </SettingsSection>
      <Suspense fallback={<p role="status">Loading file presets…</p>}>
        <FilesSettings />
      </Suspense>
    </>
  );
}
export function WidgetsSettings() {
  const { settings } = useSettings();
  const [error, setError] = useState("");
  return (
    <>
      <SettingsSection title="Sticky notes">
        <SettingsToggle
          label="Restore sticky notes at startup"
          help="Reopen the notes you left on your desktop"
          checked={settings.restoreStickyNotes ?? true}
          change={(restoreStickyNotes) => ({ restoreStickyNotes })}
        />
        <SettingsRow
          title="Pop out any note"
          help="Open a note’s menu in Notes and choose Pop out. Each sticky keeps its own position, monitor, pin and opacity."
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              setError("");
              try {
                await useAppStore.getState().patchSettings({ lastTab: "notes" });
                await api.showMainWindow();
              } catch (reason) {
                setError(String(reason));
              }
            }}
          >
            Open Notes
          </Button>
        </SettingsRow>
      </SettingsSection>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
export function PrivacySettings() {
  const engine = useAppStore((s) => s.engine);
  return (
    <>
      <SettingsSection title="Privacy">
        <p className="settings-message">
          No telemetry. Clipboard history stays local. Tack sync is opt-in, and browser cookies are
          used only for the download you choose.
        </p>
        <details className="settings-privacy">
          <summary>Privacy statement</summary>
          <pre tabIndex={0} role="region" aria-label="Privacy statement text">
            {privacyStatement}
          </pre>
        </details>
      </SettingsSection>
      <SettingsSection title="About">
        <SettingsRow title={`Nabbit ${version}`} help="Open source · MIT licence">
          <span className="settings-help">Windows 10 and 11</span>
        </SettingsRow>
        <p className="settings-message">
          yt-dlp: {engine?.ytdlpVersion ?? "not found"}
          <br />
          Deno: {engine?.denoVersion ?? "not found"}
          <br />
          ffmpeg: {engine?.ffmpegVersion ?? "not found"}
        </p>
        <Suspense fallback={<p role="status">Loading licences…</p>}>
          <Licenses />
        </Suspense>
      </SettingsSection>
    </>
  );
}
