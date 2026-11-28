import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { DesignIcon } from "../../components/DesignIcon";
import chevron from "../../assets/context/ad37e.svg";
import type { TextTool } from "./contextApi";
import "./context.css";
export function TextToolsMenu({
  tools,
  busy,
  run,
  paste,
  qr,
  save,
  close,
}: {
  tools: TextTool[];
  busy: boolean;
  run: (id: string) => void;
  paste: () => void;
  qr: () => void;
  save: () => void;
  close: () => void;
}) {
  const [group, setGroup] = useState<TextTool["group"] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const returnGroup = useRef<TextTool["group"] | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const trigger = document.activeElement;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !stage.current?.contains(event.target))
        closeRef.current();
    };
    const menu = stage.current;
    const container = menu?.closest("[data-context-kind]");
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      const target =
        trigger instanceof HTMLElement && trigger !== document.body && trigger.isConnected
          ? trigger
          : container?.querySelector<HTMLElement>("[data-text-trigger]");
      if (
        target &&
        (menu?.contains(document.activeElement) || document.activeElement === document.body)
      )
        target.focus();
    };
  }, []);
  useEffect(() => {
    const target =
      !group && returnGroup.current
        ? root.current?.querySelector<HTMLButtonElement>(`[data-group="${returnGroup.current}"]`)
        : root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    target?.focus();
    returnGroup.current = null;
  }, [group]);
  const submenu = (name: string, value: TextTool["group"]) => (
    <button
      type="button"
      role="menuitem"
      disabled={busy}
      aria-haspopup="menu"
      aria-expanded={group === value}
      data-group={value}
      onClick={() => setGroup(value)}
    >
      <span>{name}</span>
      <DesignIcon asset={{ src: chevron, file: "context/ad37e.svg", width: 14, height: 14 }} />
    </button>
  );
  const key = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" || (event.key === "ArrowLeft" && group)) {
      event.preventDefault();
      if (group) {
        returnGroup.current = group;
        setGroup(null);
      } else close();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (busy || event.repeat) return;
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      paste();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      save();
      return;
    }
    if (event.key === "ArrowRight") {
      const value = (event.target as HTMLElement).closest<HTMLElement>("[data-group]")?.dataset
        .group;
      if (value) {
        event.preventDefault();
        setGroup(value as TextTool["group"]);
      }
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = [
        ...(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
      ];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  return (
    <div ref={stage} className="text-tools-stage" onKeyDownCapture={key}>
      <div
        ref={root}
        className={"text-tools-menu" + (group ? " text-tools-submenu" : "")}
        role="menu"
        aria-label={
          group
            ? `${group === "case" ? "Change case" : group === "lines" ? "Line tools" : "Encode or decode"} submenu`
            : "Text tools"
        }
      >
        {group ? (
          tools
            .filter((tool) => tool.group === group)
            .map((tool) => (
              <button
                key={tool.id}
                role="menuitem"
                type="button"
                disabled={busy}
                onClick={() => run(tool.id)}
              >
                {tool.name}
              </button>
            ))
        ) : (
          <>
            <button role="menuitem" type="button" disabled={busy} onClick={() => run("copy")}>
              <span>Copy</span>
              <small>Enter</small>
            </button>
            <button role="menuitem" type="button" disabled={busy} onClick={paste}>
              <span>Paste as plain text</span>
              <small>Shift+Enter</small>
            </button>
            <div role="separator" />
            {submenu("Change case", "case")}
            {submenu("Trim, sort or dedupe lines", "lines")}
            <button role="menuitem" type="button" disabled={busy} onClick={() => run("json")}>
              Format JSON
            </button>
            {submenu("Encode or decode", "encoding")}
            <button role="menuitem" type="button" disabled={busy} onClick={qr}>
              Make QR code
            </button>
            <button role="menuitem" type="button" disabled={busy} onClick={() => run("count")}>
              Count words
            </button>
            <div role="separator" />
            <button role="menuitem" type="button" disabled title="Available in v2.1">
              Pin as snippet (v2.1)
            </button>
            <button role="menuitem" type="button" disabled={busy} onClick={save}>
              <span>Save to Tack</span>
              <small>Ctrl+N</small>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
