import { classify, zoneOrder, type Payload, type DropZone } from "../../lib/islandDrop";
import { IslandAsset } from "./IslandAsset";
const zones = {
  download: {
    title: "Download",
    hint: "Links and playlists",
    icon: "iconArrowDownToLine",
    muted: "iconArrowDownToLine1",
  },
  shelf: {
    title: "Add to shelf",
    hint: "Hold files for later",
    icon: "iconInbox1",
    muted: "iconInbox",
  },
  note: {
    title: "New note",
    hint: "Text, links, images",
    icon: "iconStickyNote1",
    muted: "iconStickyNote",
  },
};
export function DropContent({
  payload,
  over,
  setOver,
}: {
  payload: Payload;
  over: DropZone | null;
  setOver: (zone: DropZone) => void;
}) {
  const kind = classify(payload, true),
    order = zoneOrder(kind),
    selected = over ?? order[0];
  return (
    <div className="island-drop-content">
      <div className="island-row">
        <strong>Drop to nab</strong>
        <span className="island-muted">
          {payload.files?.length
            ? `${payload.files.length} files`
            : kind === "link"
              ? "Link"
              : kind === "text"
                ? "Text"
                : kind === "files"
                  ? "Files"
                  : "Files, links or text"}
        </span>
      </div>
      <div className="island-drop-zones">
        {order.map((zone) => (
          <div
            key={zone}
            data-drop-zone={zone}
            className={`island-drop-zone${selected === zone ? " is-over" : ""}`}
            onDragEnter={() => setOver(zone)}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(zone);
            }}
          >
            <IslandAsset
              group="drop"
              name={selected === zone ? zones[zone].icon : zones[zone].muted}
            />
            <strong>{zones[zone].title}</strong>
            <span className="island-muted">{zones[zone].hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
