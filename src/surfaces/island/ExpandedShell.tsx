import { lazy, Suspense, useLayoutEffect, useRef } from "react";
import { Tab } from "../../components/Tab";
import { IconButton } from "../../components/IconButton";
import { tabs, type IslandModel, type IslandAction } from "../../store/islandStore";
import { IslandAsset, type AssetGroup } from "./IslandAsset";
import type { IslandIntent } from "./CompactContent";
import { focusIslandTarget } from "../../lib/islandKeyboard";
const Body = lazy(() => import("./ModuleBody"));
const Search = lazy(() => import("./SearchContent"));
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
  onError,
}: {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
  act: (intent: IslandIntent) => void;
  onError: (reason: unknown) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null),
    memory = useRef(model.scroll),
    restoring = useRef(false);
  const searchOpen = model.filters.searchOpen === "true";
  const group =
    model.tab === "files" && model.filters.shelfSelection ? "34:897" : groups[model.tab];
  memory.current = model.scroll;
  useLayoutEffect(() => {
    if (searchOpen && scroll.current)
      return focusIslandTarget(scroll.current, '[aria-label="Search island"]', true);
  }, [searchOpen]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (searchOpen) {
      restoring.current = false;
      element.scrollTop = 0;
      return;
    }
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
  }, [model.tab, searchOpen]);
  return (
    <div className="island-expanded-content">
      <nav className="island-tabbar" aria-label="Island modules">
        {tabs.map((tab, index) => (
          <Tab
            key={tab}
            selected={!searchOpen && model.tab === tab}
            aria-label={labels[tab]}
            title={`${labels[tab]} (Ctrl+${index + 1})`}
            aria-keyshortcuts={`Control+${index + 1}`}
            data-island-tab={tab}
            className="island-module-tab"
            onClick={() => {
              dispatch({ type: "filter", name: "searchOpen", value: "false" });
              dispatch({ type: "tab", tab });
            }}
            style={{ "--tab-index": index } as React.CSSProperties}
          >
            <IslandAsset group={searchOpen ? "search" : group} name={icons[index]} />
            {!searchOpen && model.tab === tab && labels[tab]}
          </Tab>
        ))}
        <span className="island-spacer" />
        <IconButton
          label="Search"
          className="island-toolbar-button"
          onClick={() => {
            dispatch({
              type: "filter",
              name: "searchOpen",
              value: model.filters.searchOpen === "true" ? "false" : "true",
            });
          }}
        >
          <IslandAsset group={group} name="iconSearch" />
        </IconButton>
        <IconButton
          label="Open full app"
          className="island-toolbar-button"
          onClick={() => act({ action: "tray" })}
        >
          <IslandAsset group={group} name="iconPanelTop" />
        </IconButton>
        <IconButton
          label="Settings"
          className="island-toolbar-button"
          onClick={() => act({ action: "settings" })}
        >
          <IslandAsset group={group} name="iconSettings" />
        </IconButton>
      </nav>
      <div
        ref={scroll}
        className="island-module-scroll"
        onScroll={(event) =>
          !searchOpen &&
          !restoring.current &&
          dispatch({ type: "scroll", tab: model.tab, offset: event.currentTarget.scrollTop })
        }
      >
        <Suspense
          fallback={
            <p className="island-empty" role="status">
              Opening {labels[model.tab]}…
            </p>
          }
        >
          {searchOpen ? (
            <Search
              query={model.searchText}
              setQuery={(text) => dispatch({ type: "search", text })}
              collapse={() => dispatch({ type: "collapse" })}
              fail={onError}
            />
          ) : (
            <Body model={model} dispatch={dispatch} act={act} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
