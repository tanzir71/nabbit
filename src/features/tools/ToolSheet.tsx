import { useEffect, useRef, useState } from "react";
import { MiniButton } from "../../surfaces/island/CompactContent";
import { type Tool } from "./api";
import { mediaApi } from "./mediaApi";
import "./tools.css";
export function ToolSheet({
  tool,
  inputs = [],
  close,
}: {
  tool: Tool;
  inputs?: string[];
  close: () => void;
}) {
  return <MediaEntry tool={tool} input={inputs[0] ?? ""} inputs={inputs} close={close} />;
}
function MediaEntry({
  tool,
  input,
  inputs,
  close,
}: {
  tool: Tool;
  input: string;
  inputs: string[];
  close: () => void;
}) {
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const id = useRef(crypto.randomUUID());
  const closeRef = useRef(close);
  closeRef.current = close;
  const inputKey = JSON.stringify(inputs);
  useEffect(() => {
    let active = true;
    void mediaApi
      .open({ id: id.current, toolId: tool.id, input, inputs: JSON.parse(inputKey) as string[] })
      .then(() => {
        if (active) closeRef.current();
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [tool.id, input, inputKey, retry]);
  return (
    <section className="tool-sheet" aria-label={`${tool.name} options`}>
      <h1 className="island-sr-only">{tool.name} options</h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <MiniButton
            onClick={() => {
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            Try opening again
          </MiniButton>
          <MiniButton onClick={close}>Back</MiniButton>
        </>
      ) : (
        <p role="status">Opening {tool.name}…</p>
      )}
    </section>
  );
}
