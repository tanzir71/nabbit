import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Tab } from "../components/Tab";
import { Badge } from "../components/Badge";
import { DownloadIcon } from "../features/downloads/DownloadIcon";
import { NotesIcon } from "../features/notes/NotesIcon";
import { BrandMark } from "../components/BrandMark";
import { IconButton } from "../components/IconButton";

import { useAppStore } from "../store/useAppStore";
import { ClipboardList } from "./ClipboardList";
import { DownloadPanel } from "./DownloadPanel";
const SettingsPanel = lazy(() =>
  import("./SettingsPanel").then((module) => ({ default: module.SettingsPanel })),
);
const NotesView = lazy(() =>
  import("./NotesView").then((module) => ({ default: module.NotesView })),
);

export function Popover() {
  const settings = useAppStore((state) => state.settings);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
  const engine = useAppStore((state) => state.engine);
  const setLastTab = useAppStore((state) => state.setLastTab);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true,
      stop: (() => void) | undefined;
    const consume = async () => {
      try {
        const wanted = await invoke<boolean>("consume_island_settings_intent");
        if (active && wanted) setShowSettings(true);
      } catch (reason) {
        if (active) useAppStore.setState({ error: String(reason) });
      }
    };
    void listen("nabbit://open-settings", () => {
      void consume();
    })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        void consume();
      })
      .catch((reason) => {
        if (active) useAppStore.setState({ error: String(reason) });
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  const activeTab = settings?.lastTab ?? "download";

  if (loading || !settings) {
    return (
      <section className="grid min-h-screen place-items-center p-6">
        <div className="text-sm text-secondary">Opening Nabbit...</div>
      </section>
    );
  }

  return (
    <section className="tray-popover">
      <header className="tray-header">
        <BrandMark size={24} />
        <h1>Nabbit</h1>
        <Badge>{settings.island.enabled ? "Island on" : "Tray only"}</Badge>
        <span className="nab-spacer" />
        <IconButton
          label={
            activeTab === "download"
              ? "Search downloads"
              : activeTab === "notes"
                ? "Search notes"
                : "Search clipboard"
          }
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(
                activeTab === "download"
                  ? "nabbit:focus-download-search"
                  : activeTab === "notes"
                    ? "nabbit:focus-notes-search"
                    : "nabbit:focus-search",
              ),
            )
          }
        >
          <DownloadIcon name="search" />
        </IconButton>
        <IconButton label="Settings" onClick={() => setShowSettings(true)}>
          <DownloadIcon name="settings" />
        </IconButton>
        <IconButton
          label="Hide"
          onClick={() => void import("../lib/ipc").then(({ api }) => api.hideMainWindow())}
        >
          <DownloadIcon name="close" />
        </IconButton>
      </header>
      <div className="tray-tabs-wrap">
        <nav className="tray-tabs" aria-label="Navigation">
          <Tab selected={activeTab === "download"} onClick={() => void setLastTab("download")}>
            <DownloadIcon name="nab" />
            Nab
          </Tab>
          <Tab selected={activeTab === "notes"} onClick={() => void setLastTab("notes")}>
            <NotesIcon name="notes" />
            Notes
          </Tab>
          <Tab selected={activeTab === "clipboard"} onClick={() => void setLastTab("clipboard")}>
            <DownloadIcon name="clipboard" />
            Clipboard
          </Tab>
          <Tab disabled title="Shelf">
            <DownloadIcon name="shelf" />
            Shelf
          </Tab>
        </nav>
      </div>

      {error ? (
        <div className="border-b border-warning-base/30 bg-warning-soft px-4 py-2 text-xs text-warning-base">
          {error}
        </div>
      ) : null}

      <div className="tray-content">
        {activeTab === "download" ? (
          <DownloadPanel active={!showSettings} />
        ) : activeTab === "notes" ? (
          <Suspense
            fallback={
              <p role="status" className="p-4">
                Opening notes…
              </p>
            }
          >
            <NotesView />
          </Suspense>
        ) : (
          <ClipboardList />
        )}
      </div>

      {activeTab === "download" && (
        <footer className="tray-engine-footer">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("nabbit:engine-health"))}
            title="Download engine health"
          >
            <DownloadIcon name="engine" />
            <span>
              {engine?.missing.length || engine?.failure
                ? "Download engine needs attention"
                : "Engine ready"}
              {[
                engine?.ytdlpVersion && `yt-dlp ${engine.ytdlpVersion}`,
                engine?.denoVersion && `Deno ${engine.denoVersion}`,
                engine?.ffmpegVersion && `ffmpeg ${engine.ffmpegVersion}`,
              ]
                .filter(Boolean)
                .map((v) => ` · ${v}`)
                .join("")}
            </span>
          </button>
        </footer>
      )}
      {showSettings ? (
        <Suspense
          fallback={
            <p role="status" className="p-4 text-sm text-secondary">
              Opening settings...
            </p>
          }
        >
          <SettingsPanel onClose={() => setShowSettings(false)} />
        </Suspense>
      ) : null}
    </section>
  );
}
