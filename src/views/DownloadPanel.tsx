import { useEffect, useRef, useState } from "react";
import { classify, readDrag } from "../lib/islandDrop";
import { useAppStore } from "../store/useAppStore";
import { DownloadReview } from "../features/downloads/DownloadReview";
import { DownloadQueue } from "../features/downloads/DownloadQueue";
import { EngineHealthCard } from "./EngineHealthCard";
import "../features/downloads/downloads.css";
export function DownloadPanel({ active = true }: { active?: boolean }) {
  const engine = useAppStore((s) => s.engine),
    stage = useAppStore((s) => s.stageUrl);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(false),
    [health, setHealth] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const show = () => {
      setSearch(true);
    };
    const engine = () => setHealth((v) => !v);
    window.addEventListener("nabbit:focus-download-search", show);
    window.addEventListener("nabbit:engine-health", engine);
    return () => {
      window.removeEventListener("nabbit:focus-download-search", show);
      window.removeEventListener("nabbit:engine-health", engine);
    };
  }, []);
  useEffect(() => {
    if (search) field.current?.focus();
  }, [search]);
  return (
    <div
      className="nab-tray-body"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const payload = readDrag(e.dataTransfer);
        if (classify(payload) === "link") void stage(payload.url || payload.text || "");
      }}
    >
      {(health || engine?.missing.length || engine?.failure) && <EngineHealthCard />}
      {search && (
        <input
          ref={field}
          className="nab-search"
          aria-label="Search downloads"
          placeholder="Search downloads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setQuery("");
              setSearch(false);
            }
          }}
        />
      )}
      <DownloadReview active={active} />
      <DownloadQueue query={query} />
    </div>
  );
}
