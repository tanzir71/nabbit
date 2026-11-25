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
        <div className="text-sm text-secondary">Opening Nabbit...</div>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-[460px] flex-col overflow-hidden border-x border-subtle bg-surface shadow-popover">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-subtle px-4">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid size-8 place-items-center rounded-md bg-action-primary text-sm font-bold text-action-on-primary">
            N
          </div>
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

      <div className="grid h-12 shrink-0 grid-cols-2 gap-1 border-b border-subtle p-1.5">
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
        <div className="border-b border-warning-base/30 bg-warning-soft px-4 py-2 text-xs text-warning-base">
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
