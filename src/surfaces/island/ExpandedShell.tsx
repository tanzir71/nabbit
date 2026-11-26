import { lazy, Suspense, useLayoutEffect, useRef } from "react";
import { Tab } from "../../components/Tab";
import { IconButton } from "../../components/IconButton";
import { tabs, type IslandModel, type IslandAction } from "../../store/islandStore";
import { IslandAsset, type AssetGroup } from "./IslandAsset";
import type { IslandIntent } from "./CompactContent";
const Body = lazy(() => import("./ModuleBody"));
const labels = {
  nab: "Nab",
  notes: "Notes",
  clipboard: "Clipboard",
  files: "Files",
  media: "Media",
  timer: "Timer",
};
const icons = [
  "iconDownload",
  "iconStickyNote",
  "iconClipboardList",
  "iconFolder",
  "iconAudioLines",
  "iconTimer",
];
const groups: Record<IslandModel["tab"], AssetGroup> = {
  nab: "9:78",
  notes: "9:200",
  clipboard: "9:330",
  files: "10:249",
  media: "10:341",
  timer: "10:433",
};
export default function ExpandedShell({
  model,
  dispatch,
  act,
}: {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
  act: (intent: IslandIntent) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null),
    memory = useRef(model.scroll),
    restoring = useRef(false);
  memory.current = model.scroll;
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const wanted = memory.current[model.tab] ?? 0;
    restoring.current = wanted > 0;
    const restore = () => {
      if (!restoring.current) return;
      element.scrollTop = wanted;
      if (element.scrollHeight - element.clientHeight >= wanted) restoring.current = false;
    };
    const resize = new ResizeObserver(restore),
      mutation = new MutationObserver(restore);
    resize.observe(element);
    mutation.observe(element, { childList: true, subtree: true });
    const manual = () => {
      restoring.current = false;
    };
    element.addEventListener("wheel", manual, { passive: true });
    element.addEventListener("touchstart", manual, { passive: true });
    restore();
    return () => {
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener("wheel", manual);
      element.removeEventListener("touchstart", manual);
    };
  }, [model.tab]);
  return (
    <div className="island-expanded-content">
      <nav className="island-tabbar" aria-label="Island modules">
        {tabs.map((tab, index) => (
          <Tab
            key={tab}
            selected={model.tab === tab}
            aria-label={labels[tab]}
            title={labels[tab]}
            className="island-module-tab"
            onClick={() => dispatch({ type: "tab", tab })}
            style={{ "--tab-index": index } as React.CSSProperties}
          >
            <IslandAsset group={groups[model.tab]} name={icons[index]} />
            {model.tab === tab && labels[tab]}
          </Tab>
        ))}
        <span className="island-spacer" />
        <IconButton
          label="Search"
          className="island-toolbar-button"
          onClick={() =>
            dispatch({
              type: "filter",
              name: "searchOpen",
              value: model.filters.searchOpen === "true" ? "false" : "true",
            })
          }
        >
          <IslandAsset group={groups[model.tab]} name="iconSearch" />
        </IconButton>
        <IconButton
          label="Open full app"
          className="island-toolbar-button"
          onClick={() => act({ action: "tray" })}
        >
          <IslandAsset group={groups[model.tab]} name="iconPanelTop" />
        </IconButton>
        <IconButton
          label="Settings"
          className="island-toolbar-button"
          onClick={() => act({ action: "settings" })}
        >
          <IslandAsset group={groups[model.tab]} name="iconSettings" />
        </IconButton>
      </nav>
      <div
        ref={scroll}
        className="island-module-scroll"
        onScroll={(event) =>
          !restoring.current &&
          dispatch({ type: "scroll", tab: model.tab, offset: event.currentTarget.scrollTop })
        }
      >
        {model.filters.searchOpen === "true" && (
          <label className="island-search">
            <IslandAsset group={groups[model.tab]} name="iconSearch" />
            <input
              aria-label="Search island"
              placeholder="Search notes, links, files…"
              value={model.searchText}
              onChange={(event) => dispatch({ type: "search", text: event.target.value })}
            />
          </label>
        )}
        <Suspense
          fallback={
            <p className="island-empty" role="status">
              Opening {labels[model.tab]}…
            </p>
          }
        >
          <Body model={model} dispatch={dispatch} act={act} />
        </Suspense>
      </div>
    </div>
  );
}
