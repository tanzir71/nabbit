import type { IslandStore, IslandTab } from "../store/islandStore";
import { tabs } from "../store/islandStore";

export type KeyboardIntent =
  | { type: "toggle" | "escape" }
  | { type: "tab"; tab: IslandTab }
  | { type: "pin"; slot: number }
  | { type: "search"; text: string }
  | { type: "cycle"; backwards: boolean };
export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
}
export function keyboardIntent(
  event: KeyInput,
  state: string,
  editing: boolean,
  spaceActivates: boolean,
): KeyboardIntent | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.getModifierState?.("AltGraph"))
    return state === "expanded" && !editing && Array.from(event.key).length === 1
      ? { type: "search", text: event.key }
      : null;
  if (event.key === "Escape" && ["expanded", "peek", "drop"].includes(state))
    return event.repeat ? null : { type: "escape" };
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === " ")
    return event.repeat ? null : { type: "toggle" };
  if (state !== "expanded") return null;
  if (
    !event.repeat &&
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    /^[1-6]$/.test(event.key)
  )
    return { type: "tab", tab: tabs[Number(event.key) - 1] };
  if (
    !event.repeat &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    /^[1-9]$/.test(event.key)
  )
    return { type: "pin", slot: Number(event.key) };
  if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey)
    return { type: "cycle", backwards: event.shiftKey };
  if (
    !editing &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    Array.from(event.key).length === 1 &&
    !(spaceActivates && event.key === " ")
  )
    return { type: "search", text: event.key };
  return null;
}
const editable = (element: Element | null) =>
  Boolean(
    element?.closest(
      "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox]",
    ),
  );
const focusable = (root: HTMLElement) =>
  [
    ...root.querySelectorAll<HTMLElement>(
      "button,input,textarea,select,a[href],[tabindex],[contenteditable=true]",
    ),
  ].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      !element.closest("[inert],[aria-hidden=true]") &&
      element.getClientRects().length > 0,
  );
/** Wait only for a lazy target to mount; never poll or run a frame loop. */
export function focusIslandTarget(
  root: HTMLElement,
  selector: string,
  selectEnd = false,
  onFocus?: () => void,
) {
  const focus = () => {
    const element = root.querySelector<HTMLElement>(selector);
    if (!element || !element.getClientRects().length) return false;
    element.focus({ preventScroll: true });
    if (selectEnd && element instanceof HTMLInputElement)
      element.setSelectionRange(element.value.length, element.value.length);
    onFocus?.();
    return true;
  };
  if (focus()) return () => {};
  const observer = new MutationObserver(() => {
    if (focus()) observer.disconnect();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true });
  return () => observer.disconnect();
}
export function connectIslandKeyboard(
  root: HTMLElement,
  store: IslandStore,
  options: { toggle: () => void; pin: (slot: number) => void },
) {
  let stopFocus: (() => void) | undefined;
  let typingSearch = false;
  const focus = (selector: string, end = false, onFocus?: () => void) => {
    stopFocus?.();
    stopFocus = focusIslandTarget(root, selector, end, () => {
      typingSearch = false;
      onFocus?.();
    });
  };
  const search = (text: string) => {
    const current = store.getState();
    const next =
      typingSearch && current.filters.searchOpen === "true" ? current.searchText + text : text;
    typingSearch = true;
    current.dispatch({ type: "search", text: next });
    current.dispatch({ type: "filter", name: "searchOpen", value: "true" });
    focus('[aria-label="Search island"]', true);
  };
  const onText = (event: InputEvent | CompositionEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (store.getState().state !== "expanded" || editable(target) || !event.data) return;
    if (event instanceof InputEvent && (event.isComposing || event.inputType !== "insertText"))
      return;
    event.preventDefault();
    search(event.data);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    const current = store.getState();
    if (
      current.state === "expanded" &&
      current.tab === "files" &&
      current.filters.searchOpen !== "true"
    ) {
      root.dispatchEvent(new CustomEvent("nabbit:island-shelf-key", { detail: event }));
      if (event.defaultPrevented) return;
    }
    if (
      current.state === "expanded" &&
      current.tab === "clipboard" &&
      current.filters.searchOpen !== "true"
    ) {
      root.dispatchEvent(new CustomEvent("nabbit:island-clipboard-key", { detail: event }));
      if (event.defaultPrevented) return;
    }
    const intent = keyboardIntent(
      event,
      store.getState().state,
      editable(target),
      Boolean(target?.closest("button,a,[role=button],input[type=checkbox],input[type=radio]")),
    );
    if (!intent) return;
    event.preventDefault();
    const dispatch = store.getState().dispatch;
    switch (intent.type) {
      case "toggle":
        options.toggle();
        break;
      case "escape":
        stopFocus?.();
        dispatch({ type: "escape" });
        break;
      case "tab":
        dispatch({ type: "filter", name: "searchOpen", value: "false" });
        dispatch({ type: "tab", tab: intent.tab });
        focus(`[data-island-tab="${intent.tab}"]`);
        break;
      case "pin":
        options.pin(intent.slot);
        break;
      case "search":
        search(intent.text);
        break;
      case "cycle": {
        const elements = focusable(root),
          active = root.ownerDocument.activeElement;
        const index = elements.findIndex((element) => element === active);
        const next =
          index < 0
            ? intent.backwards
              ? elements.length - 1
              : 0
            : (index + (intent.backwards ? -1 : 1) + elements.length) % elements.length;
        elements[next]?.focus();
      }
    }
  };
  const offState = store.subscribe((next) => {
    if (next.state !== "expanded") {
      stopFocus?.();
      stopFocus = undefined;
      typingSearch = false;
    }
  });
  root.ownerDocument.defaultView?.addEventListener("keydown", onKey);
  root.addEventListener("beforeinput", onText);
  root.addEventListener("compositionend", onText);
  return {
    focus,
    dispose() {
      stopFocus?.();
      offState();
      root.ownerDocument.defaultView?.removeEventListener("keydown", onKey);
      root.removeEventListener("beforeinput", onText);
      root.removeEventListener("compositionend", onText);
    },
  };
}
