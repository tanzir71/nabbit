import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { defaultDownloadPresets } from "../../lib/downloadPresets";
import type { DownloadOptions, DownloadPreset } from "../../lib/types";
export function usePreset(url: string, memory?: string, save?: (memory: string) => void) {
  const restored = useRef(memory);
  restored.current = memory;
  const [value, setValue] = useState<{ url: string; preset: DownloadPreset; ready: boolean }>({
    url: "",
    preset: defaultDownloadPresets()[0],
    ready: false,
  });
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    if (url)
      void (
        "__TAURI_INTERNALS__" in window
          ? invoke<DownloadPreset>("resolve_download_preset", { url })
          : import("../../lib/ipc").then(({ api }) => api.resolveDownloadPreset(url))
      )
        .then((preset) => {
          if (active) {
            try {
              const prior = JSON.parse(restored.current ?? "null");
              if (
                prior?.url === url &&
                defaultDownloadPresets().some((p) => p.id === prior.preset?.id) &&
                prior.preset?.options &&
                typeof prior.preset.options === "object"
              )
                preset = prior.preset;
            } catch {
              /* Invalid local UI memory falls back to the persisted site preset. */
            }
            setValue({ url, preset, ready: true });
          }
        })
        .catch((reason) => {
          if (active) setError(String(reason));
        });
    return () => {
      active = false;
    };
  }, [url]);
  const ready = value.url === url && value.ready;
  const preset = value.url === url ? value.preset : defaultDownloadPresets()[0];
  const choose = (preset: DownloadPreset) => {
    setValue({ url, preset, ready: true });
    save?.(JSON.stringify({ url, preset }));
  };
  return {
    preset,
    ready,
    error,
    choose,
    edit: (options: DownloadOptions) => choose({ id: "custom", label: "Custom…", options }),
  };
}
