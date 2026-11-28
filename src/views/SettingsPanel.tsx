import { SettingsContext } from "../features/settings/context";
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconButton } from "../components/IconButton";
import { DownloadIcon } from "../features/downloads/DownloadIcon";
import { useAppStore } from "../store/useAppStore";
import type { SettingsPatch } from "../lib/types";
import { SettingsAsset } from "../features/settings/SettingsControls";
import { GeneralSettings } from "../features/settings/GeneralSettings";
import { IslandPreferencesPage } from "../features/settings/IslandPreferencesPage";
import { ActivitySettings } from "../features/settings/ActivitySettings";
import {
  ClipboardSettings,
  DownloadsSettings,
  FilesPreferences,
  NotesSettings,
  PrivacySettings,
  ShortcutsSettings,
  WidgetsSettings,
} from "../features/settings/OtherSettings";
import "../features/settings/settings.css";

const pages = [
  ["general", "General", "dafc4.svg", "57372.svg"],
  ["island", "Island", "d64a9.svg", "723e5.svg"],
  ["widgets", "Widgets", "27a2e.svg", "27a2e.svg"],
  ["downloads", "Downloads", "403ff.svg", "403ff.svg"],
  ["notes", "Notes & Tack", "4fac6.svg", "4fac6.svg"],
  ["clipboard", "Clipboard", "15f08.svg", "15f08.svg"],
  ["files", "Files", "4ebe2.svg", "4ebe2.svg"],
  ["shortcuts", "Shortcuts", "fac14.svg", "8b1cc.svg"],
  ["privacy", "Privacy & about", "33b6a.svg", "33b6a.svg"],
] as const;
type Page = (typeof pages)[number][0] | "activities";
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const save = useAppStore((s) => s.patchSettings);
  const [page, setPage] = useState<Page>("general");
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let stop: (() => void) | undefined;
    let pending = Promise.resolve();
    const consume = () => {
      pending = pending
        .then(async () => {
          const page = await invoke<string | null>("settings_take_page");
          if (active && (page === "island" || page === "widgets")) setPage(page);
        })
        .catch(() => {});
    };
    void listen("settings:navigate", consume)
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        consume();
      })
      .catch(() => {});
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false),
    heading = useRef<HTMLHeadingElement>(null),
    content = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    content.current?.scrollTo?.({ top: 0 });
    if (!first.current) heading.current?.focus();
    first.current = false;
  }, [page]);
  if (!settings) return null;
  const patch = async (change: SettingsPatch) => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await save(change);
      return true;
    } catch (reason) {
      setError(String(reason));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const selected = page === "activities" ? "island" : page;
  const title =
    page === "activities" ? "Live activities" : pages.find((item) => item[0] === page)![1];
  return (
    <SettingsContext.Provider value={{ settings, patch, busy }}>
      <div className="settings-window" aria-busy={busy}>
        <aside className="settings-sidebar">
          <div className="settings-brand">
            <SettingsAsset name="09016.svg" />
            <span>Nabbit settings</span>
          </div>
          <nav aria-label="Settings sections">
            {pages.map(([id, label, icon, activeIcon]) => (
              <button
                type="button"
                key={id}
                aria-current={selected === id ? "page" : undefined}
                onClick={() => setPage(id)}
              >
                <SettingsAsset name={selected === id ? activeIcon : icon} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </aside>
        <div ref={content} className="settings-content">
          <header className="settings-page-header">
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
            <IconButton label="Close settings" onClick={onClose}>
              <DownloadIcon name="close" />
            </IconButton>
          </header>
          {error && (
            <p role="alert" className="settings-error">
              {error}
            </p>
          )}
          {page === "general" && <GeneralSettings />}
          {page === "island" && <IslandPreferencesPage activities={() => setPage("activities")} />}
          {page === "activities" && <ActivitySettings />}
          {page === "widgets" && <WidgetsSettings />}
          {page === "downloads" && <DownloadsSettings />}
          {page === "notes" && <NotesSettings />}
          {page === "clipboard" && <ClipboardSettings />}
          {page === "files" && <FilesPreferences />}
          {page === "shortcuts" && <ShortcutsSettings />}
          {page === "privacy" && <PrivacySettings />}
        </div>
      </div>
    </SettingsContext.Provider>
  );
}
