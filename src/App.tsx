import { useEffect } from "react";
import { api } from "./lib/ipc";
import type { ClipboardEntry, DownloadJob, DownloadMetadata } from "./lib/types";
import { useAppStore } from "./store/useAppStore";
import { FirstRunNotice } from "./views/FirstRunNotice";
import { Popover } from "./views/Popover";

export default function App() {
  const loadInitialData = useAppStore((state) => state.loadInitialData);
  const refreshClipboard = useAppStore((state) => state.refreshClipboard);
  const refreshDownloads = useAppStore((state) => state.refreshDownloads);
  const stageUrl = useAppStore((state) => state.stageUrl);
  const settings = useAppStore((state) => state.settings);

  useEffect(() => {
    void loadInitialData();
  }, [loadInitialData]);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    void api.onEvent<ClipboardEntry>("clipboard:new", () => void refreshClipboard()).then((cleanup) => {
      cleanups.push(cleanup);
    });
    void api.onEvent<DownloadMetadata>("url:detected", (payload) => {
      void stageUrl(payload.normalizedUrl);
    }).then((cleanup) => cleanups.push(cleanup));
    void api.onEvent<DownloadJob>("download:updated", () => void refreshDownloads()).then((cleanup) => {
      cleanups.push(cleanup);
    });
    void api.onEvent<void>("shortcut:clipboard-search", () => {
      window.dispatchEvent(new CustomEvent("nabbit:focus-search"));
    }).then((cleanup) => cleanups.push(cleanup));

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [refreshClipboard, refreshDownloads, stageUrl]);

  return (
    <main className="min-h-screen bg-stone-50 text-slate-950 antialiased dark:bg-slate-950 dark:text-slate-50">
      <Popover />
      {settings && !settings.firstRunAcknowledged ? <FirstRunNotice /> : null}
    </main>
  );
}
