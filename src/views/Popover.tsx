import { Download, History, Settings, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Segmented } from "../components/Segmented";
import { IconButton } from "../components/IconButton";
import { BrandMark } from "../components/BrandMark";
import { useAppStore } from "../store/useAppStore";
import { ClipboardList } from "./ClipboardList";
import { DownloadPanel } from "./DownloadPanel";
const SettingsPanel = lazy(() =>
  import("./SettingsPanel").then((module) => ({ default: module.SettingsPanel })),
);

export function Popover() {
  const settings = useAppStore((state) => state.settings);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
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
  const tabs = useMemo(
    () => [
      {
        value: "download" as const,
        label: "Download",
        icon: <Download size={16} strokeWidth={1.75} />,
      },
      {
        value: "clipboard" as const,
        label: "Clipboard",
        icon: <History size={16} strokeWidth={1.75} />,
      },
    ],
    [],
  );

  if (loading || !settings) {
    return (
      <section className="grid min-h-screen place-items-center p-6">
        <div className="text-sm text-secondary">Opening Nabbit...</div>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-[460px] flex-col overflow-hidden border-x border-subtle bg-surface shadow-popover">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-subtle px-4">
        <div className="flex min-w-0 items-center gap-2">
          <BrandMark />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Nabbit</h1>
            <p className="truncate text-xs text-secondary">Nab it. Keep it.</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Settings" onClick={() => setShowSettings(true)}>
            <Settings size={17} />
          </IconButton>
          <IconButton
            label="Hide"
            onClick={() => void import("../lib/ipc").then(({ api }) => api.hideMainWindow())}
          >
            <X size={17} />
          </IconButton>
        </div>
      </header>

      <div className="h-12 shrink-0 border-b border-subtle p-1.5">
        <Segmented
          label="Navigation"
          value={activeTab}
          options={tabs}
          onChange={(value) => void setLastTab(value)}
        />
      </div>

      {error ? (
        <div className="border-b border-warning-base/30 bg-warning-soft px-4 py-2 text-xs text-warning-base">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "download" ? <DownloadPanel /> : <ClipboardList />}
      </div>

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
