import type { IslandMode } from "../store/islandStore";
/** A newly allocated WebView begins at the still-visible native compact scene. */
export function seedIslandMorph(pill: HTMLElement, width: number, height: number) {
  const target = {
    width: pill.style.width,
    height: pill.style.height,
    radius: pill.style.borderRadius,
  };
  pill.style.transition = "none";
  pill.style.width = `${width}px`;
  pill.style.height = `${height}px`;
  pill.style.borderRadius = pill.closest('[data-shape="notch"]')
    ? `0px 0px ${height / 2}px ${height / 2}px`
    : `${height / 2}px`;
  void pill.offsetWidth;
  pill.style.transition = "";
  pill.style.width = target.width;
  pill.style.height = target.height;
  pill.style.borderRadius = target.radius;
}
const rank: Record<IslandMode, number> = {
  hidden: 0,
  idle: 0,
  faded: 0,
  live: 1,
  peek: 2,
  drop: 2,
  expanded: 3,
};
/** Detached visual snapshot + finite CSS exit animation. No JS animation loop or timer. */
export function observeIslandMotion(
  pill: HTMLElement,
  content: HTMLElement,
  outgoing: HTMLElement,
  reduced: () => boolean,
) {
  let previous: IslandMode | null = null,
    snapshot: HTMLElement | null = null,
    box = { width: 112, height: 26 },
    active = true;
  const remember = () => {
    if (!active) return;
    snapshot = content.cloneNode(true) as HTMLElement;
    box = {
      width: content.getBoundingClientRect().width,
      height: content.getBoundingClientRect().height,
    };
  };
  const observer = new MutationObserver(remember);
  observer.observe(content, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  const clear = () => {
    outgoing.replaceChildren();
    pill.classList.remove("is-crossfading");
  };
  outgoing.addEventListener("animationend", clear);
  return {
    update(mode: IslandMode) {
      if (previous !== null && previous !== mode) {
        const collapse = rank[mode] < rank[previous];
        pill.dataset.motion = collapse ? "collapse" : mode;
        if (snapshot && (collapse || reduced())) {
          clear();
          outgoing.style.width = `${box.width}px`;
          outgoing.style.height = `${box.height}px`;
          outgoing.style.borderRadius =
            previous === "expanded"
              ? "28px"
              : previous === "peek" || previous === "drop"
                ? "24px"
                : "16px";
          outgoing.setAttribute("aria-hidden", "true");
          outgoing.inert = true;
          outgoing.append(snapshot);
          outgoing.style.animation = "none";
          void outgoing.offsetWidth;
          outgoing.style.animation = "";
          if (reduced()) pill.classList.add("is-crossfading");
        }
      }
      previous = mode;
      remember();
    },
    dispose() {
      active = false;
      observer.disconnect();
      outgoing.removeEventListener("animationend", clear);
      clear();
      snapshot = null;
    },
  };
}
