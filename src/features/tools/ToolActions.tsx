import { useEffect, useState } from "react";
import { toolsApi, acceptsFiles, type Tool } from "./api";
import { ToolSheet } from "./ToolSheet";
import { MiniButton } from "../../surfaces/island/CompactContent";
export function ToolActions({ paths }: { paths: string[] }) {
  const [tools, setTools] = useState<Tool[]>([]),
    [chosen, choose] = useState<Tool | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void toolsApi
      .catalog()
      .then((rows) => {
        if (active) setTools(rows);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  const applicable = tools.filter((tool) => acceptsFiles(tool, paths));
  return (
    <>
      {chosen ? (
        <ToolSheet
          key={chosen.id + paths.join()}
          tool={chosen}
          inputs={paths}
          close={() => choose(null)}
        />
      ) : (
        applicable.length > 0 && (
          <div className="island-row tool-actions" role="group" aria-label="File tools">
            {applicable.map((tool) => (
              <MiniButton key={tool.id} onClick={() => choose(tool)}>
                {tool.name}
              </MiniButton>
            ))}
          </div>
        )
      )}
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
    </>
  );
}
