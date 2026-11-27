import { ExternalLink, RefreshCcw, Trash2, X } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { IconButton } from "../components/IconButton";
import { Segmented } from "../components/Segmented";
import { Toggle } from "../components/Toggle";
import { api } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";
import type { AppSettings, AppUpdateStatus, Quality } from "../lib/types";
import { EngineHealthCard } from "./EngineHealthCard";
import { IslandSettings } from "./IslandSettings";
import { IslandShortcutField } from "./IslandShortcutField";
import { TackSettings } from "../features/notes/TackSettings";
const FilesSettings = lazy(() => import("../features/tools/FilesSettings"));
const Licenses = lazy(() => import("../features/tools/Licenses"));

const qualities: Array<{ label: string; value: Quality }> = [
  { label: "Best", value: "best" },
  { label: "1080", value: "1080p" },
  { label: "720", value: "720p" },
  { label: "MP3", value: "audio_mp3" },
];

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((state) => state.settings);
  const stats = useAppStore((state) => state.stats);
  const engine = useAppStore((state) => state.engine);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const clearHistory = useAppStore((state) => state.clearHistory);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);

  if (!settings) return null;

  const patch = (value: Partial<AppSettings>) => void saveSettings({ ...settings, ...value });
  const dbSize = stats ? `${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB` : "Unknown";

  return (
    <div className="fixed inset-0 z-20 bg-surface">
      <header className="flex h-14 items-center justify-between border-b border-subtle px-4">
        <h1 className="text-sm font-semibold">Settings</h1>
        <IconButton label="Close settings" onClick={onClose}>
          <X size={17} />
        </IconButton>
      </header>
      <div className="h-[calc(100vh-56px)] overflow-y-auto p-4">
        <Section title="General">
          <Segmented
            label="Appearance"
            value={settings.theme}
            options={[
              { label: "System", value: "system" },
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
            ]}
            onChange={(theme) => patch({ theme })}
          />
          <Toggle
            label="Launch at login"
            checked={settings.launchAtLogin}
            onChange={(launchAtLogin) => patch({ launchAtLogin })}
          />
          <Toggle
            label="Start hidden"
            checked={settings.startHidden}
            onChange={(startHidden) => patch({ startHidden })}
          />
          <Toggle
            label="Show dock/taskbar icon"
            checked={settings.showDockIcon}
            onChange={(showDockIcon) => patch({ showDockIcon })}
          />
          <div className="grid gap-2 sm:grid-cols-3">
            <Field
              label="Toggle"
              className="font-mono"
              value={settings.togglePopoverShortcut}
              onChange={(event) => patch({ togglePopoverShortcut: event.target.value })}
            />
            <Field
              label="Quick DL"
              className="font-mono"
              value={settings.quickDownloadShortcut}
              onChange={(event) => patch({ quickDownloadShortcut: event.target.value })}
            />
            <Field
              label="Search"
              className="font-mono"
              value={settings.clipboardSearchShortcut}
              onChange={(event) => patch({ clipboardSearchShortcut: event.target.value })}
            />
          </div>
          <Field
            label="Act on selected link"
            className="font-mono"
            value={settings.selectedTextShortcut ?? "Ctrl+Alt+S"}
            onChange={(e) => patch({ selectedTextShortcut: e.target.value })}
          />
          <IslandShortcutField
            value={settings.islandShortcut ?? "Alt+Space"}
            save={async (islandShortcut) => {
              const current = useAppStore.getState().settings;
              if (current) await saveSettings({ ...current, islandShortcut });
            }}
          />
        </Section>

        <IslandSettings value={settings.island} />

        <Section title="Notes & Tack">
          <TackSettings />
        </Section>

        <Section title="Downloads">
          <Segmented
            label="Default quality"
            value={settings.defaultQuality}
            options={qualities}
            onChange={(defaultQuality) => patch({ defaultQuality })}
          />
          <Field
            label="Output folder"
            className="font-mono"
            value={settings.outputDir}
            placeholder="Use Downloads/Nabbit"
            onChange={(event) => patch({ outputDir: event.target.value })}
          />
          <Field
            label="Filename template"
            className="font-mono"
            value={settings.filenameTemplate}
            onChange={(event) => patch({ filenameTemplate: event.target.value })}
          />
          <Field
            label="Max concurrent"
            className="font-mono"
            type="number"
            min={1}
            max={6}
            value={settings.maxConcurrentDownloads}
            onChange={(event) => patch({ maxConcurrentDownloads: Number(event.target.value) })}
          />
          <Toggle
            label="Reveal after download"
            checked={settings.revealAfterDownload}
            onChange={(revealAfterDownload) => patch({ revealAfterDownload })}
          />
          <Toggle
            label="Keep downloader engine up to date"
            checked={settings.engineAutoUpdate}
            onChange={(engineAutoUpdate) => patch({ engineAutoUpdate })}
          />
        </Section>

        <Section title="Clipboard">
          <Segmented
            label="Retention"
            value={settings.retentionDays}
            options={[
              { label: "30 days", value: 30 },
              { label: "60 days", value: 60 },
              { label: "90 days", value: 90 },
            ]}
            onChange={(retentionDays) => patch({ retentionDays })}
          />
          <Toggle
            label="Capture images"
            description="Stored only when the native backend can provide a safe thumbnail."
            checked={settings.captureImages}
            onChange={(captureImages) => patch({ captureImages })}
          />
          <Field
            label="Image cap (MB)"
            className="font-mono"
            type="number"
            min={1}
            max={50}
            value={settings.imageSizeCapMb}
            onChange={(event) => patch({ imageSizeCapMb: Number(event.target.value) })}
          />
          <Toggle
            label="Paste on select"
            checked={settings.pasteOnSelect}
            onChange={(pasteOnSelect) => patch({ pasteOnSelect })}
          />
          <Toggle
            label="Sensitive text heuristics"
            description="Skips likely OTPs, cards, and long high-entropy secrets."
            checked={settings.sensitiveHeuristics}
            onChange={(sensitiveHeuristics) => patch({ sensitiveHeuristics })}
          />
          <Toggle
            label="Auto-detect video links"
            checked={settings.autoDetectLinks}
            onChange={(autoDetectLinks) => patch({ autoDetectLinks })}
          />
          <Toggle
            label="Pause auto-detect"
            checked={settings.pauseAutoDetect}
            onChange={(pauseAutoDetect) => patch({ pauseAutoDetect })}
          />
          <div className="rounded-lg border border-subtle bg-surface p-3 text-sm">
            <p className="text-secondary">
              Stored: {stats?.clipboardCount ?? 0} clipboard items, {stats?.downloadCount ?? 0}{" "}
              downloads, {dbSize}
            </p>
            <Button
              className="mt-3"
              variant="danger"
              onClick={() => {
                if (confirm("Clear all clipboard history?")) void clearHistory();
              }}
            >
              <Trash2 size={16} />
              Clear all history
            </Button>
          </div>
        </Section>

        <Section title="Privacy">
          <p className="text-sm leading-6 text-secondary">
            Telemetry is off. Your clipboard stays local. Daily engine checks contact GitHub and
            test a fixed Creative Commons YouTube sample without downloading media. Your links are
            probed or downloaded only after your action.
          </p>
          <Button variant="secondary" onClick={() => window.open("PRIVACY.md")}>
            <ExternalLink size={16} />
            Privacy statement
          </Button>
        </Section>

        <Suspense fallback={<p role="status">Loading file presets…</p>}>
          <FilesSettings />
        </Suspense>
        <EngineHealthCard />
        <Section title="About">
          <div className="rounded-lg border border-subtle bg-surface p-3 text-sm leading-6">
            <p>Nabbit 0.1.0</p>
            <Suspense fallback={<p role="status">Loading licences…</p>}>
              <Licenses />
            </Suspense>
            <p className="text-secondary">yt-dlp: {engine?.ytdlpVersion ?? "not found"}</p>
            <p className="break-all font-mono text-secondary">
              ffmpeg: {engine?.ffmpegPath ?? "not found"}
            </p>
            <p className="text-secondary">
              Licenses: Tauri, React, yt-dlp, Deno, ffmpeg and bundled dependencies. Geist and Geist
              Mono: SIL Open Font License 1.1.
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="secondary"
              disabled={checkingUpdate}
              onClick={async () => {
                setCheckingUpdate(true);
                try {
                  setUpdateStatus(await api.checkAppUpdate());
                } finally {
                  setCheckingUpdate(false);
                }
              }}
            >
              <RefreshCcw size={14} />
              {checkingUpdate ? "Checking..." : "Check for updates"}
            </Button>
            {updateStatus ? (
              <p className="mt-2 text-secondary">
                {updateStatus.error
                  ? updateStatus.error
                  : updateStatus.available
                    ? `Update ${updateStatus.version ?? ""} available.`
                    : "Nabbit is up to date."}
              </p>
            ) : null}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6 grid gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-secondary">{title}</h2>
      {children}
    </section>
  );
}
