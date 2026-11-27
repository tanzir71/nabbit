import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { observeIslandInput } from "../../lib/islandInput";
import { connectIslandVisibility } from "../../lib/islandVisibility";
import { connectIslandActivity, getIslandStore } from "../../lib/islandActivity";
import { connectIslandSurface, type SurfaceInstruction } from "../../lib/islandSurface";
import { observeIslandMotion, seedIslandMorph } from "../../lib/islandMotion";
import { connectIslandKeyboard } from "../../lib/islandKeyboard";
import {
  activityTab,
  activityTitle,
  compactKind,
  compactWidths,
} from "../../lib/islandPresentation";
import { classify, readDrag, routeDrop, type DropZone, type Payload } from "../../lib/islandDrop";
import type { IslandAction, IslandStore } from "../../store/islandStore";
import { tabs } from "../../store/islandStore";
import { BubbleContent, CompactContent, type IslandIntent } from "./CompactContent";
import { PeekContent } from "./PeekContent";
import { DropContent } from "./DropContent";
import { notesApi } from "../../features/notes/api";
import { connectMediaInput } from "../../features/media/input";
const Expanded = lazy(() => import("./ExpandedShell"));
const native = () => "__TAURI_INTERNALS__" in window;

export function IslandApp({ suppliedStore }: { suppliedStore?: IslandStore }) {
  const label = native() ? getCurrentWindow().label : "island";
  const store = suppliedStore ?? getIslandStore(label),
    model = useStore(store);
  const host = useRef<HTMLElement>(null),
    pill = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null);
  const outgoing = useRef<HTMLDivElement>(null),
    motion = useRef<ReturnType<typeof observeIslandMotion>>();
  const [instruction, setInstruction] = useState<SurfaceInstruction | null>(null);
  const [bootstrap, setBootstrap] = useState<SurfaceInstruction["shape"] | null>(null);
  const receiving = useRef(false),
    focusedGeneration = useRef(-1),
    surfaceReady = useRef(false),
    seededNativeMorph = useRef(false),
    pendingDropZone = useRef<DropZone>(),
    incomingDrop = useRef<(data: Payload, zone?: DropZone) => Promise<void>>();
  const dropModifiers = useRef({ shift: false, ctrl: false });
  const nativeDropRevision = useRef(0);
  useEffect(() => {
    if (["idle", "live", "hidden", "faded"].includes(model.state)) {
      for (const name of ["fileMove", "fileTool"])
        if (model.filters[name]) store.getState().dispatch({ type: "filter", name, value: "" });
    }
  }, [model.state, model.filters.fileMove, model.filters.fileTool, model.filters, store]);
  const [height, setHeight] = useState(26),
    [payload, setPayload] = useState<Payload>({}),
    [over, setOver] = useState<DropZone | null>(null),
    [notice, setNotice] = useState("");
  const fail = useCallback((reason: unknown) => setNotice(String(reason)), []);
  useEffect(() => {
    if (pill.current) return connectMediaInput(pill.current, store, fail);
  }, [store, fail]);
  const visualState =
    native() && !instruction
      ? model.gate === "hidden"
        ? "hidden"
        : model.gate === "faded"
          ? "faded"
          : model.primary
            ? "live"
            : "idle"
      : model.state;
  const keyboard = useRef<ReturnType<typeof connectIslandKeyboard>>();
  const keyboardRequest = useRef(-1);
  const keyboardEntered = useRef(false);
  useEffect(() => {
    if (!host.current) return;
    keyboard.current = connectIslandKeyboard(host.current, store, {
      toggle: () => {
        void invoke("island_toggle_keyboard", { trigger: "Alt+Space" }).catch(fail);
      },
      pin: (slot) => {
        void invoke("island_open_pin", { slot, id: null })
          .then(() => store.getState().dispatch({ type: "collapse" }))
          .catch(fail);
      },
    });
    return () => {
      keyboard.current?.dispose();
      keyboard.current = undefined;
    };
  }, [store, fail]);
  useLayoutEffect(() => {
    if (model.state !== "expanded") {
      keyboardEntered.current = false;
      return;
    }
    if (
      model.state === "expanded" &&
      instruction?.keyboard &&
      instruction.keyboard.id >= keyboardRequest.current &&
      (!keyboardEntered.current || instruction.keyboard.id > keyboardRequest.current)
    ) {
      if (
        instruction.keyboard.target === "notes" &&
        (model.tab !== "notes" || model.filters.searchOpen === "true")
      ) {
        store.getState().dispatch({ type: "filter", name: "searchOpen", value: "false" });
        store.getState().dispatch({ type: "tab", tab: "notes" });
        return;
      }
      keyboardRequest.current = instruction.keyboard.id;
      keyboardEntered.current = true;
      if (instruction.keyboard.target !== "preserve")
        keyboard.current?.focus(
          instruction.keyboard.target === "notes"
            ? "[data-note-capture]:not(:disabled),[data-note-capture-disabled]"
            : model.filters.searchOpen === "true"
              ? '[aria-label="Search island"]'
              : `[data-island-tab="${model.tab}"]`,
          true,
          () => {
            void invoke("island_keyboard_ready", { request: instruction.keyboard?.id }).catch(fail);
          },
        );
    }
  }, [instruction, model.state, model.tab, model.filters.searchOpen, fail, store]);
  useLayoutEffect(() => {
    if (!pill.current || !content.current || !outgoing.current) return;
    motion.current = observeIslandMotion(
      pill.current,
      content.current,
      outgoing.current,
      () =>
        host.current?.dataset.reducedMotion === "true" ||
        matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    return () => {
      motion.current?.dispose();
      motion.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    motion.current?.update(visualState);
  }, [visualState]);
  const dispatch = useCallback(
    (action: IslandAction) => store.getState().dispatch(action),
    [store],
  );
  const act = useCallback(
    (intent: IslandIntent) => {
      const e = intent.item?.event;
      if (intent.fileReview) {
        const review = intent.fileReview;
        dispatch({ type: "filter", name: "searchOpen", value: "false" });
        dispatch({
          type: "filter",
          name: "fileTool",
          value: review.toolId ? JSON.stringify({ id: review.toolId, paths: [review.path] }) : "",
        });
        dispatch({
          type: "filter",
          name: "fileMove",
          value: review.toolId
            ? ""
            : JSON.stringify({
                paths: [review.path],
                pinId: null,
                destination: review.destination,
                site: review.site,
              }),
        });
        dispatch({ type: "tab", tab: "files" });
        dispatch({ type: "open" });
        return;
      }
      if (e?.kind === "filesMoved" && intent.action === "undo") {
        void invoke("files_undo", { id: e.opId }).catch(fail);
        return;
      }
      if (intent.action === "nab" && e?.kind === "linkDetected") {
        void invoke(
          intent.options ? "start_download" : "start_download_with_preset",
          intent.options ? { request: { url: e.url, options: intent.options } } : { url: e.url },
        ).catch(fail);
        return;
      }
      if (
        (e?.kind === "toolJob" || e?.kind === "toolResult") &&
        ["cancel", "retry", "reveal", "undo"].includes(intent.action)
      ) {
        void invoke(`tool_${intent.action}`, { id: e.jobId }).catch(fail);
        return;
      }
      if (["pause", "cancel", "reveal", "open"].includes(intent.action) && e && "jobId" in e) {
        void invoke(`${intent.action === "reveal" ? "reveal" : intent.action}_download`, {
          id: e.jobId,
        }).catch(fail);
        return;
      }
      if (intent.action === "tray" || intent.action === "settings") {
        void invoke(
          intent.action === "settings" ? "island_open_settings" : "show_main_window",
        ).catch(fail);
        return;
      }
      store.getState().dispatch({
        type: "tab",
        tab: intent.action === "fileReview" ? "files" : activityTab(intent.item ?? null),
      });
      if (intent.action === "fileReview" || e?.kind === "toolJob" || e?.kind === "toolResult")
        store.getState().dispatch({ type: "filter", name: "searchOpen", value: "false" });
      if (intent.preset && e?.kind === "linkDetected")
        store.getState().dispatch({
          type: "filter",
          name: "nabDraft",
          value: JSON.stringify({ url: e.url, preset: intent.preset }),
        });
      if (native()) void invoke("island_keyboard_focus", { target: "tab" }).catch(fail);
      if (intent.action === "audioReview")
        store.getState().dispatch({ type: "filter", name: "preset", value: "audio_mp3" });
      dispatch({ type: "open" });
    },
    [dispatch, fail, store],
  );
  useEffect(() => {
    if (!host.current || !pill.current) return;
    if (!native()) {
      if (store.getState().revision < 0) store.setState({ state: "idle", gate: "visible" });
      return;
    }
    const input = observeIslandInput(pill.current, host.current, {
        enabled: () => surfaceReady.current,
      }),
      visibility = connectIslandVisibility(host.current);
    const activity = connectIslandActivity(store, { onError: fail });
    let active = true;
    const surface: ReturnType<typeof connectIslandSurface> = connectIslandSurface(
      label,
      (value) => {
        receiving.current = true;
        store.getState().dispatch({ type: "backend", snapshot: value.snapshot });
        store.getState().dispatch({ type: "present", state: value.state });
        if (
          value.focusTab &&
          tabs.includes(value.focusTab) &&
          value.generation !== focusedGeneration.current
        ) {
          store.getState().dispatch({ type: "filter", name: "searchOpen", value: "false" });
          store.getState().dispatch({ type: "tab", tab: value.focusTab });
          focusedGeneration.current = value.generation;
        }
        setInstruction(value);
        surfaceReady.current = true;
        receiving.current = false;
      },
      fail,
      async (value) => {
        performance.mark("nabbit:surface-prepare-start");
        await Promise.all([
          ...(value.state === "expanded"
            ? [import("./ExpandedShell"), import("./ModuleBody")]
            : []),
          ...(value.state === "expanded" && store.getState().filters.searchOpen === "true"
            ? [import("./SearchContent")]
            : []),
          document.fonts.load('600 14px "Geist"'),
          document.fonts.load('500 12px "Geist Mono"'),
          document.fonts.ready,
          visibility.known,
          activity.ready,
        ]);
        await surface.shown;
        if (!active) return;
        if (!value.reducedMotion) {
          setBootstrap(value.shape);
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          if (!active) return;
          await Promise.all(
            [...document.images].map((image) => image.decode().catch(() => undefined)),
          );
          if (host.current) host.current.dataset.compactPrepared = "true";
        }
        performance.mark("nabbit:surface-prepare-end");
        performance.measure(
          "nabbit:surface-preparation",
          "nabbit:surface-prepare-start",
          "nabbit:surface-prepare-end",
        );
      },
    );
    const offState = store.subscribe((next, previous) => {
      if (surfaceReady.current && !receiving.current && next.state !== previous.state)
        void invoke("island_surface_request", { state: next.state }).catch(fail);
    });
    let offDrop: (() => void) | undefined;
    let offNativeDrop: (() => void) | undefined;
    void listen<{
      kind: string;
      payload: Payload;
      x: number;
      y: number;
      shift: boolean;
      ctrl: boolean;
    }>("nabbit://native-drop", ({ payload: event }) => {
      if (!active) return;
      const modifiers = { shift: event.shift, ctrl: event.ctrl };
      dropModifiers.current = modifiers;
      const x = event.x / devicePixelRatio,
        y = event.y / devicePixelRatio;
      const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-zone]")
        ?.dataset.dropZone as DropZone | undefined;
      if (
        host.current?.dataset.shelfOutgoing === "true" &&
        (event.kind !== "drop" || !zone?.startsWith("pin:"))
      )
        return;
      if (event.kind === "enter") {
        const revision = ++nativeDropRevision.current;
        setPayload({
          ...event.payload,
          modifiers,
          types: event.payload.files?.length ? ["Files"] : ["text/plain"],
        });
        void invoke("island_set_drag", { active: true })
          .then(() => {
            if (active && revision === nativeDropRevision.current) dispatch({ type: "dragEnter" });
          })
          .catch(fail);
      }
      if (event.kind === "over") {
        setOver(zone ?? null);
        setPayload((previous) =>
          previous.modifiers?.shift === modifiers.shift &&
          previous.modifiers?.ctrl === modifiers.ctrl
            ? previous
            : { ...previous, modifiers },
        );
      }
      if (event.kind === "leave") {
        nativeDropRevision.current++;
        void invoke("island_set_drag", { active: false }).catch(fail);
        dispatch({ type: "dragLeave" });
        setOver(null);
      }
      if (event.kind === "drop") {
        nativeDropRevision.current++;
        void incomingDrop.current?.({ ...event.payload, modifiers }, zone);
        void invoke("island_set_drag", { active: false }).catch(fail);
      }
    })
      .then((stop) => {
        if (active) offNativeDrop = stop;
        else stop();
      })
      .catch(fail);
    void getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (!active) return;
        if (event.payload.type === "enter") {
          setPayload({ files: event.payload.paths });
          return;
        }
        if (event.payload.type !== "drop") return;
        if (host.current?.dataset.shelfOutgoing === "true") return;
        const x = event.payload.position.x / devicePixelRatio,
          y = event.payload.position.y / devicePixelRatio;
        const zone =
          pendingDropZone.current ??
          (document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-zone]")?.dataset
            .dropZone as DropZone | undefined);
        pendingDropZone.current = undefined;
        void incomingDrop.current?.(
          { files: event.payload.paths, modifiers: dropModifiers.current },
          zone,
        );
        void invoke("island_set_drag", { active: false }).catch(fail);
      })
      .then((stop) => {
        if (active) offDrop = stop;
        else stop();
      })
      .catch(fail);
    return () => {
      surface.dispose();
      offState();
      active = false;
      offDrop?.();
      offNativeDrop?.();
      activity.dispose();
      visibility.dispose();
      void input.dispose();
    };
  }, [store, label, fail, dispatch]);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () =>
      setHeight(Math.min(420, Math.ceil(element.getBoundingClientRect().height)));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [model.state]);
  useLayoutEffect(() => {
    if (!instruction || !pill.current || seededNativeMorph.current) return;
    seededNativeMorph.current = true;
    if (!instruction.reducedMotion && ["peek", "expanded", "drop"].includes(instruction.state))
      seedIslandMorph(pill.current, instruction.width, instruction.height);
  }, [instruction]);
  useEffect(() => {
    if (!instruction || !pill.current) return;
    const element = pill.current;
    let active = true,
      frame = 0;
    const ack = async () => {
      await document.fonts.ready;
      if (!active) return;
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined)),
      );
      if (active)
        frame = requestAnimationFrame(() => {
          if (active)
            void invoke("island_surface_ack", { generation: instruction.generation }).catch(fail);
        });
    };
    frame = requestAnimationFrame(() => {
      void ack();
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [instruction, fail]);
  const alertId = model.alert?.id;
  useLayoutEffect(() => {
    const element = pill.current;
    if (!element || !alertId) return;
    element.classList.remove("is-alert");
    void element.offsetWidth;
    element.classList.add("is-alert");
  }, [alertId]);
  const receiveDrop = async (data: Payload, zone?: DropZone) => {
    const receipt = routeDrop(data, zone ?? over ?? undefined);
    setPayload(data);
    if (receipt.message !== "Ready for review") {
      setNotice(receipt.message);
      dispatch({ type: "dragLeave" });
      return;
    }
    if (receipt.zone === "move" || receipt.zone.startsWith("pin:")) {
      store.getState().dispatch({ type: "filter", name: "fileTool", value: "" });
      store.getState().dispatch({ type: "filter", name: "searchOpen", value: "false" });
      store.getState().dispatch({
        type: "filter",
        name: "fileMove",
        value: JSON.stringify({
          paths: data.files ?? [],
          pinId: receipt.zone.startsWith("pin:") ? receipt.zone.slice(4) : null,
          modifiers: data.modifiers ?? { shift: false, ctrl: false },
        }),
      });
      store.getState().dispatch({ type: "tab", tab: "files" });
      dispatch({ type: "open" });
    } else if (receipt.zone.startsWith("tool:")) {
      store.getState().dispatch({ type: "filter", name: "fileMove", value: "" });
      store.getState().dispatch({ type: "filter", name: "searchOpen", value: "false" });
      store.getState().dispatch({
        type: "filter",
        name: "fileTool",
        value: JSON.stringify({ id: receipt.zone.slice(5), paths: data.files ?? [] }),
      });
      store.getState().dispatch({ type: "tab", tab: "files" });
      dispatch({ type: "open" });
    } else if (receipt.zone === "download" && classify(data) === "link") {
      const url = data.url || data.text?.trim() || "";
      try {
        await invoke("island_review_url", { url });
        store.getState().dispatch({ type: "tab", tab: "nab" });
        dispatch({ type: "open" });
      } catch (reason) {
        fail(reason);
      }
    } else if (receipt.zone === "note" && classify(data) === "link") {
      const url = data.url || data.text?.trim() || "";
      try {
        const { scope } = await notesApi.state();
        await notesApi.capture({
          requestId: crypto.randomUUID(),
          expectedScope: scope,
          draft: { kind: "bookmark", title: url, url, priority: "inbox", labels: [] },
          patch: {},
          reminders: [],
        });
        dispatch({ type: "dragLeave" });
        dispatch({ type: "collapse" });
      } catch (reason) {
        fail(reason);
      }
    } else {
      // Module-owned staging preserves the payload; the receiving service can consume it.
      try {
        await invoke("island_stage_drop", { payload: data, zone: receipt.zone });
        store
          .getState()
          .dispatch({ type: "tab", tab: receipt.zone === "note" ? "notes" : "files" });
        dispatch({ type: "open" });
      } catch (reason) {
        fail(reason);
      }
    }
    setOver(null);
  };
  incomingDrop.current = receiveDrop;
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    dropModifiers.current = { shift: event.shiftKey, ctrl: event.ctrlKey };
    if (host.current?.dataset.shelfOutgoing === "true") return;
    if (native() && event.dataTransfer.files.length) {
      pendingDropZone.current =
        event.target instanceof Element
          ? (event.target.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone as
              DropZone | undefined)
          : (over ?? undefined);
      try {
        const bridge = window as unknown as {
          chrome: {
            webview: { postMessageWithAdditionalObjects: (message: string, files: File[]) => void };
          };
        };
        bridge.chrome.webview.postMessageWithAdditionalObjects(
          JSON.stringify({
            nabbit_file_drop: true,
            x: event.clientX,
            y: event.clientY,
            scale: devicePixelRatio,
          }),
          Array.from(event.dataTransfer.files),
        );
      } catch {
        fail("This item has no disk file path");
        dispatch({ type: "dragLeave" });
      }
      return;
    }
    const zone =
      event.target instanceof Element
        ? (event.target.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone as
            DropZone | undefined)
        : undefined;
    void receiveDrop({ ...readDrag(event.dataTransfer), modifiers: dropModifiers.current }, zone);
  };
  const compact = ["idle", "faded", "hidden", "live"].includes(visualState),
    kind = compactKind(model.primary);
  const primaryWidth = model.primary
    ? model.bubble
      ? 260
      : compactWidths[kind]
    : (instruction?.shape ?? bootstrap) === "notch"
      ? 168
      : 112;
  const width = compact
    ? primaryWidth + (model.bubble ? 38 : 0)
    : model.state === "peek"
      ? 400
      : model.state === "drop"
        ? 640
        : 680;
  const targetHeight = compact
    ? model.primary
      ? 32
      : instruction?.shape === "notch"
        ? 24
        : 26
    : height;
  return (
    <main
      ref={host}
      className="island-host"
      data-theme="dark"
      data-native={native() || undefined}
      data-island-state={visualState}
      data-shape={instruction?.shape ?? bootstrap ?? "island"}
      data-reduced-motion={instruction?.reducedMotion || undefined}
      aria-label="Nabbit island"
      style={
        native()
          ? undefined
          : { opacity: model.state === "hidden" ? 0 : model.state === "faded" ? 0.35 : 1 }
      }
      onPointerDown={(event) => {
        if (event.target === host.current) dispatch({ type: "outside" });
        else if (native() && model.state === "expanded" && event.button === 0)
          void invoke("island_keyboard_focus", { target: "preserve" }).catch(fail);
      }}
      onDragEnter={(event) => {
        if (host.current?.dataset.shelfOutgoing === "true") return;
        if (
          [...(event.dataTransfer.types ?? [])].some((type) =>
            ["Files", "text/plain", "text/uri-list"].includes(type),
          )
        ) {
          const types = [...event.dataTransfer.types];
          setPayload((previous) =>
            previous.types?.join("|") === types.join("|") ? previous : { types },
          );
          if (model.state !== "drop") setOver(null);
          dispatch({ type: "dragEnter" });
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (host.current?.dataset.shelfOutgoing === "true") return;
        const types = [...event.dataTransfer.types];
        setPayload((previous) =>
          previous.types?.join("|") === types.join("|") ? previous : { types },
        );
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node && host.current?.contains(event.relatedTarget)))
          dispatch({ type: "dragLeave" });
      }}
      onDrop={(event) => {
        void drop(event);
      }}
    >
      {compact && <h1 className="island-sr-only">Nabbit island</h1>}
      <div
        ref={pill}
        className={`island-morph${compact && model.bubble ? " is-split" : ""}`}
        data-kind={kind}
        data-bootstrapping={(native() && !instruction) || undefined}
        data-alert={model.alert?.id}
        style={{
          width,
          height: targetHeight,
          visibility: native() && !instruction && !bootstrap ? "hidden" : undefined,
        }}
        onPointerEnter={() => dispatch({ type: "enter", now: performance.now() })}
        onPointerLeave={() => dispatch({ type: "leave", now: performance.now() })}
      >
        <div
          ref={content}
          className={`island-content island-content--${visualState}`}
          style={{ width }}
        >
          {compact ? (
            <>
              <div
                className="island-compact"
                style={{ width: primaryWidth }}
                onClick={() => dispatch({ type: "open" })}
              >
                <CompactContent item={model.primary} act={act} />
              </div>
              {model.bubble && (
                <button
                  className="island-bubble"
                  title={activityTitle(model.bubble)}
                  aria-label={activityTitle(model.bubble)}
                  onClick={() => act({ action: "review", item: model.bubble ?? undefined })}
                >
                  <BubbleContent item={model.bubble} />
                </button>
              )}
            </>
          ) : model.state === "peek" && model.primary ? (
            <PeekContent item={model.primary} act={act} />
          ) : model.state === "drop" ? (
            <DropContent payload={payload} over={over} setOver={setOver} />
          ) : (
            <Suspense fallback={<div className="island-empty">Opening island…</div>}>
              <Expanded model={model} dispatch={dispatch} act={act} onError={fail} />
            </Suspense>
          )}
        </div>
        <div ref={outgoing} className="island-outgoing" aria-hidden="true" />
      </div>
      {notice && (
        <button className="island-notice" role="alert" onClick={() => setNotice("")}>
          {notice}
        </button>
      )}
    </main>
  );
}
