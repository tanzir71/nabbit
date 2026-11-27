import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "../../lib/useTheme";
import { NoteCard } from "../../components/NoteCard";
import { IconButton } from "../../components/IconButton";
import { Button } from "../../components/Button";
import { DesignIcon } from "../../components/DesignIcon";
import { stickyAssets } from "../../features/notes/stickyAssets";
import { stickyApi, type StickyProfile } from "../../features/notes/stickyApi";
import { useStickyDraft } from "../../features/notes/useStickyDraft";
import { SyncState } from "../../features/notes/SyncState";
import { syncCopy } from "../../features/notes/syncCopy";
import type { TackSyncSnapshot } from "../../features/notes/tackApi";
import { sameScope } from "../../features/notes/captureDraft";
function StickyIcon({ name }: { name: keyof typeof stickyAssets }) {
  return <DesignIcon asset={stickyAssets[name]} />;
}
export function StickyApp() {
  const state = useStickyDraft(),
    s = state.session,
    c = s?.value;
  useTheme(state.theme);
  const [menu, setMenu] = useState(false),
    [preferencesBusy, setPreferencesBusy] = useState(false),
    [preferenceError, setPreferenceError] = useState(""),
    [reloadChoice, setReloadChoice] = useState(false),
    [bodyVisible, setBodyVisible] = useState(false);
  const paper = useRef<HTMLElement>(null),
    content = useRef<HTMLDivElement>(null),
    bar = useRef<HTMLElement>(null),
    footer = useRef<HTMLElement>(null),
    ready = useRef<string>(),
    itemFocus = useRef<string>(),
    configuring = useRef(false);
  const menuRoot = useRef<HTMLElement>(null),
    moreWrap = useRef<HTMLSpanElement>(null),
    decision = useRef<HTMLDivElement>(null);
  const deciding = state.closeChoice || reloadChoice;
  useEffect(() => {
    if (!deciding || !decision.current || !paper.current) return;
    const origin = document.activeElement;
    const others = [...paper.current.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== decision.current,
    );
    others.forEach((el) => (el.inert = true));
    decision.current.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      others.forEach((el) => (el.inert = false));
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
    };
  }, [deciding]);
  useLayoutEffect(() => {
    for (const element of paper.current?.querySelectorAll<HTMLTextAreaElement>("textarea") ?? []) {
      element.style.height = "auto";
      element.style.height = `${Math.max(element.scrollHeight, parseFloat(getComputedStyle(element).lineHeight) || 18)}px`;
    }
    if (itemFocus.current) {
      const target = [
        ...(paper.current?.querySelectorAll<HTMLTextAreaElement>("[data-sticky-item]") ?? []),
      ].find((el) => el.dataset.stickyItem === itemFocus.current);
      if (target) {
        target.focus();
        itemFocus.current = undefined;
      }
    }
  }, [c?.title, c?.body, c?.items, bodyVisible]);
  useEffect(() => {
    if (!s || ready.current === s.snapshot.binding.instance) return;
    ready.current = s.snapshot.binding.instance;
    const height =
      (bar.current?.offsetHeight ?? 34) +
      (content.current?.scrollHeight ?? 80) +
      (footer.current?.offsetHeight ?? 28) +
      2;
    void stickyApi
      .ready(s.snapshot.binding.instance, height)
      .catch(() => setPreferenceError("This window's size could not be restored."));
  }, [s]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !menuRoot.current?.contains(event.target) &&
        !moreWrap.current?.contains(event.target)
      )
        setMenu(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  const configure = async (
    change: Partial<Pick<StickyProfile, "pinned" | "opacity" | "monitor">>,
  ) => {
    if (!s || configuring.current) return;
    configuring.current = true;
    setPreferencesBusy(true);
    setPreferenceError("");
    try {
      await stickyApi.configure(s.snapshot.binding.instance, change);
      await state.refresh();
    } catch {
      setPreferenceError("Window settings could not be saved. The previous settings are kept.");
    } finally {
      configuring.current = false;
      setPreferencesBusy(false);
    }
  };
  const addItem = () => {
    if (!c) return;
    const id = crypto.randomUUID();
    itemFocus.current = id;
    state.update("items", [...c.items, { id, text: "", checked: false }]);
  };
  const currentSync: TackSyncSnapshot | null = s
    ? s.snapshot.content.status === "scopeChanged"
      ? {
          state: "workspaceChanged",
          scope: s.snapshot.binding.scope,
          pending: 0,
          conflicts: 0,
          referenceIssues: 0,
          lastSynced: null,
          error: null,
          nextAttemptMs: null,
        }
      : state.sync && sameScope(state.sync.scope, s.snapshot.binding.scope)
        ? state.sync
        : null
    : null;
  const copyTitle = currentSync ? syncCopy(currentSync).title : "Checking sync status…";
  const footerTitle = state.saving
    ? "Saving on this PC…"
    : state.dirty
      ? "Unsaved draft"
      : s?.snapshot.content.status === "gone"
        ? "Original card unavailable"
        : s?.snapshot.binding.scope === null
          ? "Saved on this PC"
          : copyTitle;
  const caption = `${footerTitle}${c?.ref ? ` · ${c.ref}` : ""}`;
  const changeItems = (id: string, checked: boolean) => {
    if (c)
      state.update(
        "items",
        c.items.map((i) => (i.id === id ? { ...i, checked } : i)),
      );
  };
  const noteContent =
    c?.kind === "bookmark"
      ? { kind: c.kind, url: c.url }
      : c?.kind === "checklist" || c?.kind === "task"
        ? {
            kind: c.kind,
            items: c.items.map((i) => ({ ...i, disabled: state.locked })),
            onItemChange: changeItems,
          }
        : { kind: "note" as const, body: c?.body ?? "" };
  const actions =
    state.error || preferenceError || !state.liveUpdates || s?.snapshot.content.status !== "ready";
  return (
    <main
      ref={paper}
      className="sticky-surface"
      data-color={c?.color ?? "default"}
      aria-label="Sticky note"
      style={
        s && !s.snapshot.nativeOpacity ? { opacity: s.snapshot.profile.opacity / 100 } : undefined
      }
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu) {
          event.preventDefault();
          setMenu(false);
          moreWrap.current?.querySelector("button")?.focus();
        } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          void state.flush();
        }
      }}
    >
      <h1 className="sr-only">Sticky note</h1>
      <header
        ref={bar}
        className="sticky-titlebar"
        onMouseDown={(event) => {
          if (
            event.button === 0 &&
            !(event.target instanceof Element && event.target.closest("button"))
          )
            void stickyApi
              .drag()
              .catch(() => setPreferenceError("This window could not be moved."));
        }}
      >
        <span className="sticky-grip" title="Drag note">
          <StickyIcon name="grip" />
        </span>
        <span className="sticky-spacer" />
        <IconButton
          label={s?.snapshot.profile.pinned ? "Unpin window" : "Keep window on top"}
          active={s?.snapshot.profile.pinned}
          disabled={!s || preferencesBusy}
          size={28}
          onClick={() => void configure({ pinned: !s?.snapshot.profile.pinned })}
        >
          <StickyIcon name="pin" />
        </IconButton>
        <span ref={moreWrap}>
          <IconButton
            label="Sticky note options"
            size={28}
            aria-expanded={menu}
            disabled={!s}
            onClick={() => setMenu((v) => !v)}
          >
            <StickyIcon name="more" />
          </IconButton>
        </span>
        <IconButton label="Close sticky note" size={28} onClick={() => void state.close()}>
          <StickyIcon name="close" />
        </IconButton>
      </header>
      {menu && s && (
        <section ref={menuRoot} className="sticky-menu" aria-label="Sticky note options">
          <Button
            variant="ghost"
            size="sm"
            disabled={state.saving}
            onClick={() => {
              setMenu(false);
              void state.openEditor();
            }}
          >
            Open full editor
          </Button>
          <label>
            Opacity <span>{s.snapshot.profile.opacity}%</span>
            <input
              aria-label="Window opacity"
              type="range"
              min={60}
              max={100}
              step={5}
              value={s.snapshot.profile.opacity}
              disabled={preferencesBusy}
              onChange={(e) => void configure({ opacity: Number(e.target.value) })}
            />
          </label>
          <label>
            Display
            <select
              aria-label="Sticky note display"
              value={s.snapshot.profile.monitor}
              disabled={preferencesBusy}
              onChange={(e) => void configure({ monitor: e.target.value })}
            >
              {s.snapshot.monitors.map((m, index) => (
                <option value={m.id} key={m.id}>
                  {index + 1} · {m.name}
                </option>
              ))}
            </select>
          </label>
          {c && !(c.kind === "note" || c.body || bodyVisible) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={state.locked}
              onClick={() => {
                setBodyVisible(true);
                setMenu(false);
              }}
            >
              Add note text
            </Button>
          )}
        </section>
      )}
      <div className="sticky-scroll">
        <div ref={content} className="sticky-content-inner">
          {c ? (
            <NoteCard
              {...noteContent}
              title={c.title || "Untitled note"}
              color={c.color}
              className="sticky-card"
              titleEditor={
                <textarea
                  className="sticky-heading"
                  rows={1}
                  aria-label="Note title"
                  placeholder="Untitled note"
                  maxLength={300}
                  value={c.title}
                  disabled={state.locked}
                  onChange={(e) => state.update("title", e.target.value)}
                  onBlur={() => void state.flush()}
                />
              }
              bodyEditor={
                c.kind === "note" || c.body || bodyVisible ? (
                  <textarea
                    className="sticky-body-input"
                    rows={1}
                    aria-label="Note body"
                    placeholder="Take a note…"
                    maxLength={200000}
                    value={c.body}
                    disabled={state.locked}
                    onChange={(e) => state.update("body", e.target.value)}
                    onBlur={() => void state.flush()}
                  />
                ) : undefined
              }
              checkIcon={(checked) => (checked ? <StickyIcon name="check" /> : null)}
              itemEditor={(item, index) => (
                <>
                  <textarea
                    rows={1}
                    aria-label={`Checklist item ${index + 1}`}
                    data-sticky-item={item.id}
                    placeholder="List item"
                    maxLength={200000}
                    value={item.text}
                    disabled={state.locked}
                    onChange={(e) =>
                      state.update(
                        "items",
                        c.items.map((i) => (i.id === item.id ? { ...i, text: e.target.value } : i)),
                      )
                    }
                    onBlur={() => void state.flush()}
                  />
                  <IconButton
                    size={28}
                    label={`Remove item ${index + 1}`}
                    disabled={state.locked}
                    onClick={() =>
                      state.update(
                        "items",
                        c.items.filter((i) => i.id !== item.id),
                      )
                    }
                  >
                    <StickyIcon name="close" />
                  </IconButton>
                </>
              )}
              trailing={
                c.kind === "task" || c.kind === "checklist" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="sticky-add"
                    disabled={state.locked}
                    onClick={addItem}
                  >
                    <StickyIcon name="plus" />
                    List item
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="sticky-empty" role="status">
              {state.loading ? "Opening note…" : "No note selected"}
            </div>
          )}
          {actions && (
            <div className="sticky-messages">
              {!state.liveUpdates && (
                <p role="alert">
                  Live note updates are unavailable. Reopen this note before editing.
                </p>
              )}
              {s?.snapshot.content.status === "gone" && (
                <p role="status">
                  This card was removed. Your note and any unsaved draft are kept here.
                </p>
              )}
              {s?.snapshot.content.status === "scopeChanged" && (
                <p role="status">
                  Workspace changed. This window keeps the original note and draft.
                </p>
              )}
              {s?.snapshot.content.readOnly && <p role="status">This workspace is read-only.</p>}
              {(state.error || preferenceError) && (
                <p role="alert">{state.error || preferenceError}</p>
              )}
              {s && (state.error || s.snapshot.content.status !== "ready") && (
                <div className="sticky-recovery">
                  <Button size="sm" disabled={state.saving} onClick={() => void state.flush()}>
                    Retry save
                  </Button>
                  <Button
                    size="sm"
                    disabled={state.saving || s.snapshot.content.readOnly}
                    onClick={() => void state.copy()}
                  >
                    {s.snapshot.content.currentScope
                      ? "Save as new in current workspace"
                      : "Save as new on this PC"}
                  </Button>
                  <Button
                    size="sm"
                    disabled={state.saving}
                    onClick={() => (state.dirty ? setReloadChoice(true) : void state.reload())}
                  >
                    Reload note
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <footer
        ref={footer}
        className="sticky-footer"
        data-sticky-save-state={state.saving ? "saving" : state.dirty ? "draft" : "saved"}
      >
        {currentSync ? (
          <SyncState
            snapshot={currentSync}
            compact
            titleOverride={caption}
            iconOverride={<StickyIcon name="cloud" />}
          />
        ) : (
          <div className="sticky-caption" role="status">
            <StickyIcon name="cloud" />
            <span>{caption}</span>
          </div>
        )}
      </footer>
      {deciding && (
        <div
          ref={decision}
          className="sticky-decision"
          role="alertdialog"
          aria-modal="true"
          aria-label="Keep your sticky draft"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setReloadChoice(false);
              state.setCloseChoice(false);
            } else if (event.key === "Tab") {
              const buttons = [...event.currentTarget.querySelectorAll("button")];
              const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
              if (document.activeElement === edge) {
                event.preventDefault();
                (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
              }
            }
          }}
        >
          <p>
            {reloadChoice
              ? "Reloading discards this draft. The saved card stays in its workspace."
              : "Your draft has not been saved to the card. Keep it here or discard it before closing."}
          </p>
          <div>
            <Button
              size="sm"
              onClick={() => {
                setReloadChoice(false);
                state.setCloseChoice(false);
              }}
            >
              Keep editing
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                if (reloadChoice) {
                  setReloadChoice(false);
                  void state.reload();
                } else void state.discardClose();
              }}
            >
              {reloadChoice ? "Discard draft and reload" : "Discard draft and close"}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
