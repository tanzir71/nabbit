import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api } from "../lib/ipc";
import { listen } from "@tauri-apps/api/event";
import { notesApi, type NotesNavigation } from "../features/notes/api";
import { Tab } from "../components/Tab";
import { Badge } from "../components/Badge";
import { DownloadIcon } from "../features/downloads/DownloadIcon";
import { NotesIcon } from "../features/notes/NotesIcon";
import { BrandMark } from "../components/BrandMark";
import { IconButton } from "../components/IconButton";
import { invoke } from "@tauri-apps/api/core";
import type { TrayFileDrop } from "./TrayFiles";
import { trayClipboardAssets } from "../features/clipboard/trayAssets";
import { DesignIcon } from "../components/DesignIcon";

import { useAppStore } from "../store/useAppStore";
import { ClipboardList } from "./ClipboardList";
import { DownloadPanel } from "./DownloadPanel";
const NotesView = lazy(() =>
  import("./NotesView").then((module) => ({ default: module.NotesView })),
);
const TrayFiles = lazy(() =>
  import("./TrayFiles").then((module) => ({ default: module.TrayFiles })),
);

export function Popover() {
  const settings = useAppStore((state) => state.settings);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
  const engine = useAppStore((state) => state.engine);
  const setLastTab = useAppStore((state) => state.setLastTab);
  const [notesNavigation, setNotesNavigation] = useState<NotesNavigation | null>(null);
  const [fileDrop, setFileDrop] = useState<TrayFileDrop | null>(null);
  const consumedDrop = useCallback(
    (id: number) => setFileDrop((drop) => (drop?.id === id ? null : drop)),
    [],
  );
  const [trayNotice, setTrayNotice] = useState<string | null>(null);
  useEffect(() => {
    if (settings?.lastTab !== "notes") setNotesNavigation(null);
  }, [settings?.lastTab]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    let stop: (() => void) | undefined;
    let pending = Promise.resolve();
    const consume = () => {
      pending = pending
        .then(async () => {
          const notice = await invoke<string | null>("tray_take_notice");
          if (active && notice) setTrayNotice(notice);
        })
        .catch((reason: unknown) => {
          if (active) setTrayNotice(String(reason));
        });
    };
    void listen("tray:notice", consume)
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        consume();
      })
      .catch((reason: unknown) => {
        if (active) setTrayNotice(String(reason));
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true;
    let stop: (() => void) | undefined;
    let revision = 0;
    void listen<{
      kind: string;
      x: number;
      y: number;
      shift: boolean;
      ctrl: boolean;
      payload: { files?: string[]; text?: string; url?: string };
    }>("nabbit://native-drop", ({ payload: event }) => {
      if (!active || event.kind !== "drop") return;
      const paths = event.payload.files;
      if (paths?.length) {
        const target = document.elementFromPoint(
          event.x / devicePixelRatio,
          event.y / devicePixelRatio,
        );
        const zone = target?.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone;
        setFileDrop({
          id: ++revision,
          paths,
          pinId: zone?.startsWith("pin:") ? zone.slice(4) : null,
          modifiers: { shift: event.shift, ctrl: event.ctrl },
        });
        setNotesNavigation(null);
        void useAppStore.getState().setLastTab("files");
      } else {
        const text = event.payload.url || event.payload.text;
        if (text) {
          setNotesNavigation(null);
          void useAppStore
            .getState()
            .stageUrl(text)
            .then(() => useAppStore.getState().setLastTab("download"));
        }
      }
    })
      .then(async (unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        await invoke("tray_ready");
      })
      .catch((reason: unknown) => {
        if (active) useAppStore.setState({ error: String(reason) });
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true,
      stop: (() => void) | undefined;
    let pending = Promise.resolve();
    const consume = async () => {
      try {
        const reply = await notesApi.takeIntent();
        if (!active) return;
        if (reply.shortcutError) useAppStore.setState({ error: reply.shortcutError });
        if (reply.navigation) {
          setNotesNavigation(reply.navigation);
          useAppStore.setState((s) => ({
            settings: s.settings ? { ...s.settings, lastTab: "notes" } : s.settings,
          }));
        }
      } catch {
        if (active)
          useAppStore.setState({
            error: "Notes navigation could not be loaded. Open the Notes tab to continue.",
          });
      }
    };
    const schedule = () => {
      pending = pending.then(consume);
    };
    void listen("notes:open", schedule)
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        schedule();
      })
      .catch(() => {
        if (active)
          useAppStore.setState({
            error: "Notes shortcut events are unavailable. Open the Notes tab to continue.",
          });
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  const activeTab = settings?.lastTab ?? "download";
  const [resolvedTheme, setResolvedTheme] = useState(
    () => document.documentElement.dataset.theme ?? "light",
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setResolvedTheme(document.documentElement.dataset.theme ?? "light"),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    setResolvedTheme(document.documentElement.dataset.theme ?? "light");
    return () => observer.disconnect();
  }, []);
  const clipboardDark = activeTab === "clipboard" && resolvedTheme === "dark";

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
        {clipboardDark ? (
          <img
            src={trayClipboardAssets.logo.src}
            width={24}
            height={24}
            alt=""
            data-asset={trayClipboardAssets.logo.file}
          />
        ) : (
          <BrandMark size={24} />
        )}
        <h1>Nabbit</h1>
        <Badge>{settings.island.enabled ? "Island on" : "Island off"}</Badge>
        <span className="nab-spacer" />
        <IconButton
          label={
            activeTab === "download"
              ? "Search downloads"
              : activeTab === "notes"
                ? "Search notes"
                : activeTab === "files"
                  ? "Search files"
                  : "Search clipboard"
          }
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(
                activeTab === "download"
                  ? "nabbit:focus-download-search"
                  : activeTab === "notes"
                    ? "nabbit:focus-notes-search"
                    : activeTab === "files"
                      ? "nabbit:focus-files-search"
                      : "nabbit:focus-search",
              ),
            )
          }
        >
          {clipboardDark ? (
            <DesignIcon asset={trayClipboardAssets.headerSearch} />
          ) : (
            <DownloadIcon name="search" />
          )}
        </IconButton>
        <IconButton
          label="Settings"
          onClick={() =>
            void api
              .openSettingsWindow()
              .catch((reason: unknown) => useAppStore.setState({ error: String(reason) }))
          }
        >
          {clipboardDark ? (
            <DesignIcon asset={trayClipboardAssets.settings} />
          ) : (
            <DownloadIcon name="settings" />
          )}
        </IconButton>
        <IconButton
          label="Hide"
          onClick={() => void import("../lib/ipc").then(({ api }) => api.hideMainWindow())}
        >
          {clipboardDark ? (
            <DesignIcon asset={trayClipboardAssets.close} />
          ) : (
            <DownloadIcon name="close" />
          )}
        </IconButton>
      </header>
      <div className="tray-tabs-wrap">
        <nav className="tray-tabs" aria-label="Navigation">
          <Tab
            selected={activeTab === "download"}
            onClick={() => {
              setNotesNavigation(null);
              void setLastTab("download");
            }}
          >
            {clipboardDark ? (
              <DesignIcon asset={trayClipboardAssets.tabNab} />
            ) : (
              <DownloadIcon name="nab" />
            )}
            Nab
          </Tab>
          <Tab
            selected={activeTab === "notes"}
            onClick={() => {
              setNotesNavigation(null);
              void setLastTab("notes");
            }}
          >
            {clipboardDark ? (
              <DesignIcon asset={trayClipboardAssets.tabNotes} />
            ) : (
              <NotesIcon name="notes" />
            )}
            Notes
          </Tab>
          <Tab
            selected={activeTab === "clipboard"}
            onClick={() => {
              setNotesNavigation(null);
              void setLastTab("clipboard");
            }}
          >
            {clipboardDark ? (
              <DesignIcon asset={trayClipboardAssets.tabClipboard} />
            ) : (
              <DownloadIcon name="clipboard" />
            )}
            Clipboard
          </Tab>
          <Tab
            selected={activeTab === "files"}
            title="Shelf and Pins"
            onClick={() => {
              setNotesNavigation(null);
              void setLastTab("files");
            }}
          >
            {clipboardDark ? (
              <DesignIcon asset={trayClipboardAssets.tabFiles} />
            ) : (
              <DownloadIcon name="shelf" />
            )}
            Files
          </Tab>
        </nav>
      </div>

      {error ? (
        <div className="border-b border-warning-base/30 bg-warning-soft px-4 py-2 text-xs text-warning-base">
          {error}
        </div>
      ) : null}
      {trayNotice && (
        <div className="tray-notice" role="status">
          <span>{trayNotice}</span>
          <button
            type="button"
            onClick={() => setTrayNotice(null)}
            aria-label="Dismiss tray message"
          >
            ×
          </button>
        </div>
      )}

      <div className="tray-content">
        {activeTab === "download" ? (
          <DownloadPanel active />
        ) : activeTab === "notes" ? (
          <Suspense
            fallback={
              <p role="status" className="p-4">
                Opening notes…
              </p>
            }
          >
            <NotesView navigation={notesNavigation} />
          </Suspense>
        ) : activeTab === "files" ? (
          <Suspense
            fallback={
              <p role="status" className="p-4">
                Opening files…
              </p>
            }
          >
            <TrayFiles drop={fileDrop} consumed={consumedDrop} />
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
    </section>
  );
}
