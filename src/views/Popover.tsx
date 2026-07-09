import { Download, History, Settings, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { useAppStore } from "../store/useAppStore";
import { ClipboardList } from "./ClipboardList";
import { DownloadPanel } from "./DownloadPanel";
import { SettingsPanel } from "./SettingsPanel";

export function Popover() {
  const settings = useAppStore((state) => state.settings);
  const loading = useAppStore((state) => state.loading);
  const error = useAppStore((state) => state.error);
  const setLastTab = useAppStore((state) => state.setLastTab);
  const [showSettings, setShowSettings] = useState(false);

  const activeTab = settings?.lastTab ?? "download";
  const tabs = useMemo(
    () => [
      { id: "download" as const, label: "Download", icon: Download },
      { id: "clipboard" as const, label: "Clipboard", icon: History },
    ],
    [],
  );

  if (loading || !settings) {
    return (
      <section className="grid min-h-screen place-items-center p-6">
        <div className="text-sm text-slate-500">Opening Nabbit...</div>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-[460px] flex-col overflow-hidden border-x border-slate-200 bg-white shadow-popover dark:border-slate-800 dark:bg-slate-950">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4 dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid size-8 place-items-center rounded-md bg-slate-950 text-sm font-bold text-white dark:bg-white dark:text-slate-950">
            N
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Nabbit</h1>
            <p className="truncate text-xs text-slate-500">Nab it. Keep it.</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Settings" onClick={() => setShowSettings(true)}>
            <Settings size={17} />
          </IconButton>
          <IconButton label="Hide" onClick={() => void import("../lib/ipc").then(({ api }) => api.hideMainWindow())}>
            <X size={17} />
          </IconButton>
        </div>
      </header>

      <div className="grid h-12 shrink-0 grid-cols-2 gap-1 border-b border-slate-200 p-1.5 dark:border-slate-800">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Button
              key={tab.id}
              variant={activeTab === tab.id ? "primary" : "ghost"}
              onClick={() => void setLastTab(tab.id)}
              className="h-9"
            >
              <Icon size={16} />
              {tab.label}
            </Button>
          );
        })}
      </div>

      {error ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "download" ? <DownloadPanel /> : <ClipboardList />}
      </div>

      {showSettings ? <SettingsPanel onClose={() => setShowSettings(false)} /> : null}
    </section>
  );
}
