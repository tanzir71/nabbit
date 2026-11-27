import { useEffect, useState } from "react";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { MiniButton } from "../../surfaces/island/CompactContent";
import { basename, bytes } from "../../lib/islandPresentation";
import { toolsApi, acceptsFile, type Tool } from "../tools/api";
import { filesApi, pinName } from "./api";
export default function DownloadDonePeek({
  path,
  jobId,
  review,
}: {
  path: string;
  jobId: string;
  review: (request: {
    path: string;
    toolId?: string;
    destination?: string;
    site?: string | null;
  }) => void;
}) {
  const [info, setInfo] = useState<{ path: string; bytes: number; site: string | null } | null>(
    null,
  );
  const [suggestions, setSuggestions] = useState<string[]>([]),
    [tool, setTool] = useState<Tool | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      filesApi.suggestions([path]),
      toolsApi.catalog(),
      filesApi.downloadInfo(jobId),
    ])
      .then(([suggestions, tools, info]) => {
        if (active) {
          setSuggestions(suggestions);
          setInfo(info);
          setTool(tools.find((tool) => acceptsFile(tool, path)) ?? null);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [path, jobId]);
  const location = info?.path ?? path;
  return (
    <section className="island-peek-content" aria-label="Download saved">
      <h1 className="island-sr-only">Download saved</h1>
      <div className="island-row">
        <IslandAsset group="peek" name="iconCircleCheck" />
        <strong className="island-spacer">
          Saved to {basename(location.replace(/[\\/][^\\/]+$/u, ""))}
        </strong>
        <span className="island-muted">
          {location.split(".").pop()?.toUpperCase()}
          {info ? ` · ${bytes(info.bytes)}` : ""}
        </span>
      </div>
      <div className="island-result-name">{basename(location)}</div>
      <div className="island-row">
        {tool && (
          <MiniButton
            signal
            onClick={() => review({ path: location, toolId: tool.id, site: info?.site })}
          >
            {tool.name}
          </MiniButton>
        )}
        {suggestions.slice(0, 1).map((destination) => (
          <MiniButton
            key={destination}
            onClick={() => review({ path: location, destination, site: info?.site })}
          >
            Move to {pinName({ path: destination, label: null })}
          </MiniButton>
        ))}
        <MiniButton onClick={() => review({ path: location, site: info?.site })}>
          Move to…
        </MiniButton>
      </div>
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
    </section>
  );
}
