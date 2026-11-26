import { useEngineEvents } from "./lib/useEngineEvents";
import { useEffect } from "react";
import { api } from "./lib/ipc";
import type { ClipboardEntry, DownloadJob, DownloadMetadata } from "./lib/types";
import { useAppStore } from "./store/useAppStore";
import { FirstRunNotice } from "./views/FirstRunNotice";
import { Popover } from "./views/Popover";
import { useTheme } from "./lib/useTheme";

export default function App() {
  useEngineEvents();
  const loadInitialData = useAppStore((state) => state.loadInitialData);
  const refreshClipboard = useAppStore((state) => state.refreshClipboard);
  const refreshDownloads = useAppStore((state) => state.refreshDownloads);
  const acceptCapturedLink = useAppStore((state) => state.acceptCapturedLink);
  const settings = useAppStore((state) => state.settings);
  useTheme(settings?.theme);

  useEffect(() => {
    void loadInitialData();
  }, [loadInitialData]);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    let active = true;
    const keep = (cleanup: () => void) => {
      if (active) cleanups.push(cleanup);
      else cleanup();
    };
    void api.onEvent<ClipboardEntry>("clipboard:new", () => void refreshClipboard()).then(keep);
    void api
      .onEvent<DownloadMetadata>("url:detected", (payload) => {
        acceptCapturedLink(payload);
      })
      .then(keep);
    void api
      .onEvent<void>("capture:review", () => {
        void useAppStore.getState().setLastTab("download");
      })
      .then(keep);
    void api
      .onEvent<string>("capture:error", (error) => useAppStore.setState({ error }))
      .then(keep);
    void api.onEvent<DownloadJob>("download:updated", () => void refreshDownloads()).then(keep);
    void api
      .onEvent<void>("shortcut:clipboard-search", () => {
        window.dispatchEvent(new CustomEvent("nabbit:focus-search"));
      })
      .then(keep);

    return () => {
      active = false;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [refreshClipboard, refreshDownloads, acceptCapturedLink]);

  return (
    <main className="min-h-screen bg-canvas text-primary antialiased">
      <Popover />
      {settings && !settings.firstRunAcknowledged ? <FirstRunNotice /> : null}
    </main>
  );
}
