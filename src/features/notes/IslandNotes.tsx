import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNotesStore } from "../../store/notesStore";
import type { IslandAction, IslandModel } from "../../store/islandStore";
import { NoteCard } from "../../components/NoteCard";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { QuickCapture } from "./QuickCapture";
import { IslandNotesSync } from "./IslandNotesSync";
import { notesApi, type NotesIntent } from "./api";
import { visibleNotes } from "./types";
import "./islandNotes.css";

export function IslandNotes({
  model,
  dispatch,
}: {
  model: IslandModel;
  dispatch: (action: IslandAction) => void;
}) {
  const { cards, scope, preferences, loading, readOnly, refresh, updateNote, busy, error } =
    useNotesStore();
  const [navigationError, setNavigationError] = useState("");
  useEffect(() => {
    let active = true,
      stop: (() => void) | undefined;
    // Install the event listener before loading so an acknowledgement cannot be missed.
    void listen("notes:updated", () => {
      if (active) void refresh();
    })
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        void refresh();
      })
      .catch(() => {
        if (active) setNavigationError("Notes events are unavailable. Open All notes to continue.");
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [refresh]);
  const open = async (intent: NotesIntent) => {
    try {
      await notesApi.open(intent);
    } catch {
      setNavigationError("Notes could not be opened. Your capture is preserved.");
      throw new Error("Notes navigation failed");
    }
  };
  const recent = visibleNotes(cards, "notes", "all", "", "", scope ? preferences : undefined).slice(
    0,
    3,
  );
  return (
    <section className="island-notes" aria-label="Quick notes">
      <QuickCapture
        island
        scope={scope}
        readOnly={readOnly}
        ready={!loading}
        cards={cards}
        initial={model.filters.noteCapture}
        persist={(value) => dispatch({ type: "filter", name: "noteCapture", value })}
        open={(request) => open({ kind: "new", request })}
        saved={() => {
          void refresh();
          dispatch({ type: "collapse" });
        }}
      />
      {!!recent.length && (
        <div className="island-recent-notes" role="group" aria-label="Recent notes">
          {recent.map((note) => {
            const c = note.value,
              disabled = readOnly || busy.includes(c.id);
            const content =
              c.kind === "note"
                ? { kind: c.kind, body: c.body }
                : c.kind === "bookmark"
                  ? { kind: c.kind, url: c.url }
                  : {
                      kind: c.kind,
                      items: c.items.slice(0, 2).map((item) => ({ ...item, disabled })),
                      onItemChange: (id: string, checked: boolean) => {
                        void updateNote(note, {
                          items: c.items.map((item) =>
                            item.id === id ? { ...item, checked } : item,
                          ),
                        });
                      },
                    };
            const dot = {
              green: "tackColor",
              blue: "tackColor1",
              default: "tackColor2",
              gray: "tackColor2",
            }[c.color as string];
            return (
              <NoteCard
                key={c.id}
                {...content}
                title={c.title || (c.kind === "bookmark" ? c.url : "Untitled note")}
                color={c.color}
                labels={c.labels.slice(0, 2)}
                className="island-recent-note"
                titlePrefix={
                  dot ? (
                    <IslandAsset group="9:200" name={dot} />
                  ) : (
                    <i className={`island-note-dot is-${c.color}`} />
                  )
                }
                checkIcon={(checked) => (
                  <IslandAsset group="9:200" name={checked ? "iconSquareCheck" : "iconSquare"} />
                )}
                onOpen={() => {
                  void open({ kind: "card", id: c.id, expectedScope: scope }).catch(() => {});
                }}
              />
            );
          })}
        </div>
      )}
      {!recent.length && !loading && (
        <p className="island-muted island-notes-empty">
          Take a note above. It stays on this device.
        </p>
      )}
      {(navigationError || error) && (
        <p className="island-error" role="alert">
          {navigationError || error}
        </p>
      )}
      <IslandNotesSync
        recent
        open={() => {
          void open({ kind: "all" }).catch(() => {});
        }}
      />
    </section>
  );
}
