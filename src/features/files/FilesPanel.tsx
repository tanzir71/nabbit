import { useMemo, useEffect, useState } from "react";
import { toolsApi, acceptsFile, type Tool } from "../tools/api";
import { ToolSheet } from "../tools/ToolSheet";
import { MiniButton } from "../../surfaces/island/CompactContent";
import type { IslandAction, IslandModel } from "../../store/islandStore";
import { IslandShelf } from "../shelf/IslandShelf";
import { ToolQueue } from "../tools/ToolQueue";
import { Pins } from "./Pins";
import { FileHistory } from "./FileHistory";
import { MoveTo } from "./MoveTo";
import type { Modifiers } from "./api";
export function FilesPanel({
  model,
  dispatch,
}: {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
}) {
  const move = useMemo(() => {
    try {
      const value = JSON.parse(model.filters.fileMove || "null");
      return value &&
        Array.isArray(value.paths) &&
        value.paths.every((p: unknown) => typeof p === "string")
        ? (value as {
            paths: string[];
            pinId: string | null;
            modifiers: Modifiers;
            destination?: string;
            site?: string | null;
          })
        : null;
    } catch {
      return null;
    }
  }, [model.filters.fileMove]);
  const review = useMemo(() => {
    try {
      return JSON.parse(model.filters.fileTool || "null") as { id: string; paths: string[] } | null;
    } catch {
      return null;
    }
  }, [model.filters.fileTool]);
  if (review)
    return (
      <ToolReview
        id={review.id}
        paths={review.paths}
        close={() => dispatch({ type: "filter", name: "fileTool", value: "" })}
      />
    );
  if (move)
    return (
      <MoveTo
        paths={move.paths}
        initialPin={move.pinId}
        initialDestination={move.destination}
        site={move.site}
        modifiers={move.modifiers}
        onFiled={() => {
          dispatch({ type: "filter", name: "fileMove", value: "" });
          dispatch({ type: "collapse" });
        }}
        close={() => dispatch({ type: "filter", name: "fileMove", value: "" })}
      />
    );
  return (
    <>
      <IslandShelf model={model} dispatch={dispatch} pins={<Pins />} />
      <ToolQueue />
      <FileHistory />
    </>
  );
}
function ToolReview({ id, paths, close }: { id: string; paths: string[]; close: () => void }) {
  const [tool, setTool] = useState<Tool | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void toolsApi
      .catalog()
      .then((rows) => {
        if (active) {
          const tool = rows.find((t) => t.id === id);
          if (tool && paths.length === 1 && acceptsFile(tool, paths[0])) setTool(tool);
          else setError("Choose one supported file for this tool.");
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [id, paths]);
  return tool ? (
    <ToolSheet tool={tool} inputs={paths} close={close} />
  ) : (
    <>
      <p role={error ? "alert" : "status"}>{error || "Loading file tool…"}</p>
      <MiniButton onClick={close}>Close</MiniButton>
    </>
  );
}
