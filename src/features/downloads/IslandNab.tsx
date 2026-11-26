import { useEffect } from "react";
import { api } from "../../lib/ipc";
import type { DownloadMetadata } from "../../lib/types";
import { useAppStore } from "../../store/useAppStore";
import { useEngineEvents } from "../../lib/useEngineEvents";
import { EngineHealthCard } from "../../views/EngineHealthCard";
import { DownloadReview } from "./DownloadReview";
import { DownloadQueue } from "./DownloadQueue";
import "./downloads.css";
import type { IslandModel, IslandAction } from "../../store/islandStore";
export function IslandNab({
  model,
  dispatch,
}: { model?: IslandModel; dispatch?: (action: IslandAction) => void } = {}) {
  useEngineEvents();
  const engine = useAppStore((s) => s.engine),
    error = useAppStore((s) => s.error);
  useEffect(() => {
    let active = true;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => {
      if (active) stops.push(stop);
      else stop();
    };
    const fail = (reason: unknown) => {
      if (active) useAppStore.setState({ error: String(reason) });
    };
    const refresh = () => {
      void useAppStore.getState().refreshDownloads().catch(fail);
    };
    void Promise.all([
      api
        .onEvent<DownloadMetadata>("url:detected", (m) => {
          if (active) useAppStore.getState().acceptCapturedLink(m);
        })
        .then(keep),
      api.onEvent("download:updated", refresh).then(keep),
      api.onEvent("download:cleared", refresh).then(keep),
      api
        .onEvent<string>("url:cleared", (url) => {
          if (active) useAppStore.getState().acceptClearedLink(url);
        })
        .then(keep),
    ])
      .then(() => {
        if (active) void useAppStore.getState().loadDownloadData().catch(fail);
      })
      .catch(fail);
    return () => {
      active = false;
      stops.forEach((stop) => stop());
    };
  }, []);
  return (
    <div className="island-module-body nab-island-body">
      {(engine?.missing.length || engine?.failure) && <EngineHealthCard />}
      <DownloadReview
        island
        memory={model?.filters.nabDraft}
        onMemoryChange={
          dispatch ? (value) => dispatch({ type: "filter", name: "nabDraft", value }) : undefined
        }
      />
      <DownloadQueue island />
      {error && (
        <p role="alert" className="nab-error">
          {error}
        </p>
      )}
    </div>
  );
}
