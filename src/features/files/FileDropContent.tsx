import { useEffect, useRef, useState } from "react";
import { IslandAsset, type AssetGroup } from "../../surfaces/island/IslandAsset";
import type { Payload, DropZone } from "../../lib/islandDrop";
import { toolsApi, type Tool } from "../tools/api";
import { filesApi, pinName, type Pin, type Modifiers } from "./api";
import "./files.css";
export default function FileDropContent({
  payload,
  over,
  setOver,
}: {
  payload: Payload;
  over: DropZone | null;
  setOver: (zone: DropZone) => void;
}) {
  const [pins, setPins] = useState<Pin[]>([]),
    [tools, setTools] = useState<Tool[]>([]),
    [suggestion, setSuggestion] = useState<string | null>(null),
    [hints, setHints] = useState<Record<string, string>>({}),
    [modifiers, setModifiers] = useState<Modifiers>({ shift: false, ctrl: false }),
    [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    setSuggestion(null);
    if (payload.files?.length === 1)
      void toolsApi
        .suggest(payload.files)
        .then((value) => {
          if (active) setSuggestion(value);
        })
        .catch(() => {
          if (active) setSuggestion(null);
        });
    return () => {
      active = false;
    };
  }, [payload.files]);
  useEffect(() => {
    if (payload.modifiers)
      setModifiers((old) =>
        old.shift === payload.modifiers!.shift && old.ctrl === payload.modifiers!.ctrl
          ? old
          : payload.modifiers!,
      );
  }, [payload.modifiers]);
  useEffect(() => {
    let active = true;
    void Promise.all([filesApi.pins(), toolsApi.catalog()])
      .then(([pins, tools]) => {
        if (active) {
          setPins(pins.filter((p) => p.kind === "folder" && p.available).slice(0, 4));
          setTools(tools);
        }
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const update = (event: KeyboardEvent) =>
      setModifiers((old) =>
        old.shift === event.shiftKey && old.ctrl === event.ctrlKey
          ? old
          : { shift: event.shiftKey, ctrl: event.ctrlKey },
      );
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    const current = ++revision.current;
    if (payload.files?.length)
      void filesApi
        .hints(payload.files, modifiers)
        .then((value) => {
          if (active && current === revision.current) setHints(value);
        })
        .catch(() => {
          if (active) setHints({});
        });
    return () => {
      active = false;
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
    };
  }, [payload.files, modifiers]);
  const tool = tools.find((tool) => tool.id === suggestion);
  const primary: DropZone = tool ? `tool:${tool.id}` : "shelf";
  const selected = over ?? primary;
  const zones: { id: DropZone; title: string; hint: string; icon: string; group: AssetGroup }[] = [
    ...(tool
      ? [
          {
            id: primary,
            title: tool.id === "fit-size" ? "Fit for Discord" : tool.name,
            hint: "Review before running",
            icon: tool.category === "media" ? "iconFilm" : "iconImage",
            group: tool.category === "media" ? ("34:897" as const) : ("drop" as const),
          },
        ]
      : []),
    {
      id: "shelf",
      title: "Add to shelf",
      hint: "Hold files for later",
      icon: "iconInbox",
      group: "drop",
    },
    {
      id: "move",
      title: "Move to…",
      hint: "Pick any folder",
      icon: "iconFolderInput",
      group: "drop",
    },
  ];
  return (
    <div
      className="island-drop-content"
      onDragOver={(event) =>
        setModifiers((old) =>
          old.shift === event.shiftKey && old.ctrl === event.ctrlKey
            ? old
            : { shift: event.shiftKey, ctrl: event.ctrlKey },
        )
      }
    >
      <h1 className="island-sr-only">Drop files</h1>
      <div className="island-row">
        <strong>Drop to file</strong>
        <span className="island-muted">
          {payload.files?.length
            ? `${payload.files.length} ${payload.files.length === 1 ? "file" : "files"}`
            : "Files"}
        </span>
      </div>
      <div className="island-drop-zones">
        {zones.map((zone) => (
          <div
            key={zone.id}
            data-drop-zone={zone.id}
            className={`island-drop-zone${selected === zone.id ? " is-over" : ""}`}
            onDragEnter={() => setOver(zone.id)}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(zone.id);
            }}
          >
            <IslandAsset group={zone.group} name={zone.icon} />
            <strong>{zone.title}</strong>
            <span className="island-muted">{zone.hint}</span>
          </div>
        ))}
      </div>
      {pins.length > 0 && (
        <section className="files-drop-pins" aria-label="Drop on a pin">
          <header className="files-heading">
            <span>DROP ON A PIN</span>
            <span>Same drive moves · other drive copies · Shift moves · Ctrl copies</span>
          </header>
          <div className="files-pin-grid">
            {pins.map((pin) => (
              <div
                key={pin.id}
                data-drop-zone={`pin:${pin.id}`}
                className={`files-pin${over === `pin:${pin.id}` ? " is-over" : ""}`}
                onDragEnter={() => setOver(`pin:${pin.id}`)}
                onDragOver={(event) => {
                  event.preventDefault();
                  setOver(`pin:${pin.id}`);
                }}
              >
                <span>
                  <IslandAsset group="drop" name={pin.network ? "iconHardDrive" : "iconFolder"} />
                  {pinName(pin)}
                </span>
                <small>
                  {hints[pin.id] ??
                    (modifiers.ctrl
                      ? "Copy here"
                      : modifiers.shift || pin.alwaysMove
                        ? "Move here"
                        : "Move / copy")}
                </small>
              </div>
            ))}
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
    </div>
  );
}
