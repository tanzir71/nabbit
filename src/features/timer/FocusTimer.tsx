import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { PresetChip } from "../../components/PresetChip";
import { Toggle } from "../../components/Toggle";
import { IslandAsset } from "../../surfaces/island/IslandAsset";
import { islandAssetUrl } from "../../surfaces/island/islandAssets";
import { duration } from "../../lib/islandPresentation";
import { notesApi } from "../notes/api";
import type { NotesState } from "../notes/types";
import { listen } from "@tauri-apps/api/event";
import { useTimer } from "./useTimer";
import type { TimerConfig, TimerSnapshot, TimerAction } from "./api";
import "./timer.css";
const presets = [
  { preset: "25/5", focusS: 1500, breakS: 300, rounds: 4 },
  { preset: "50/10", focusS: 3000, breakS: 600, rounds: 4 },
  { preset: "90", focusS: 5400, breakS: 0, rounds: 1 },
] as const;
function Ring({ remaining, planned }: { remaining: number; planned: number }) {
  const value = Math.max(0, Math.min(1, remaining / Math.max(1, planned))),
    degrees = value * 360;
  return (
    <div
      className="focus-ring"
      role="progressbar"
      aria-label="Focus time remaining"
      aria-valuemin={0}
      aria-valuemax={Math.max(planned, remaining)}
      aria-valuenow={remaining}
      aria-valuetext={duration(remaining)}
    >
      <IslandAsset group="10:433" name="ellipse" />
      {degrees > 216 && (
        <span
          className="focus-ring-extra"
          style={{
            maskImage: `url(${JSON.stringify(islandAssetUrl("10:433", "ellipse"))})`,
            background: `conic-gradient(transparent 0deg 216deg,var(--signal-base) 216deg ${degrees}deg,transparent ${degrees}deg)`,
          }}
        />
      )}
      <span
        className="focus-ring-arc"
        style={{
          maskImage: `conic-gradient(#000 0deg ${Math.min(216, degrees)}deg,transparent ${Math.min(216, degrees)}deg)`,
        }}
      >
        <IslandAsset group="10:433" name="ellipse1" />
      </span>
      <span className="focus-clock-centre">
        <span
          className="focus-digits"
          style={
            { "--focus-digit-size": remaining >= 60000 ? "20px" : "26px" } as React.CSSProperties
          }
        >
          {duration(remaining)}
        </span>
      </span>
    </div>
  );
}
function nextLabel(s: TimerSnapshot) {
  if (s.session?.status === "running") return "Pause";
  if (s.session?.status === "paused") return "Resume";
  if (s.session?.status === "ended" && s.session.round < s.config.rounds)
    return s.session.phase === "focus" && s.config.breakS > 0 ? "Start break" : "Next round";
  return "Start";
}
function Controls({
  snapshot,
  peek,
  act,
  busy,
}: {
  snapshot: TimerSnapshot;
  peek: boolean;
  act: (action: TimerAction) => Promise<boolean>;
  busy: boolean;
}) {
  const label = nextLabel(snapshot),
    action: TimerAction = {
      kind:
        snapshot.session?.status === "running"
          ? "pause"
          : snapshot.session?.status === "paused"
            ? "resume"
            : "start",
    };
  const icon =
    snapshot.session?.status === "running" ? (
      <IslandAsset group={peek ? "peek" : "10:433"} name="iconPause" />
    ) : (
      <Play size={14} style={{ width: 14, height: 14 }} aria-hidden="true" />
    );
  return peek ? (
    <>
      <IconButton
        variant="island"
        size={28}
        label={`${label} timer`}
        disabled={busy}
        onClick={() => void act(action)}
      >
        {icon}
      </IconButton>
      <IconButton
        variant="island"
        size={28}
        label="Stop timer"
        disabled={busy || !snapshot.session}
        onClick={() => void act({ kind: "stop" })}
      >
        <IslandAsset group="peek" name="iconSquare" />
      </IconButton>
    </>
  ) : (
    <>
      <button
        className="focus-button"
        type="button"
        disabled={busy}
        onClick={() => void act(action)}
      >
        {icon}
        {label}
      </button>
      <button
        className="focus-button"
        type="button"
        disabled={busy || !snapshot.session}
        onClick={() => void act({ kind: "stop" })}
      >
        <IslandAsset group="10:433" name="iconSquare" />
        Stop
      </button>
    </>
  );
}
function CardPicker({
  close,
  choose,
  current,
}: {
  close: () => void;
  choose: (card: TimerConfig["card"]) => Promise<boolean>;
  current: TimerSnapshot["linkedCard"];
}) {
  const [data, setData] = useState<NotesState | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      serial = 0,
      stop: (() => void) | undefined;
    const load = async () => {
      const current = ++serial;
      setData(null);
      try {
        const next = await notesApi.state();
        if (active && current === serial) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void listen("notes:updated", () => void load())
      .then((unlisten) => {
        if (!active) {
          unlisten();
          return;
        }
        stop = unlisten;
        void load();
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);
  const cards = data?.cards.filter((c) => !c.value.trashedAt && !c.value.archived) ?? [];
  return (
    <div className="focus-card-picker" role="group" aria-label="Link a card">
      <div className="focus-picker-title">
        <strong>Link a card</strong>
        <button className="focus-button" type="button" onClick={close}>
          Close
        </button>
      </div>
      {current && (
        <div className="focus-controls">
          <button
            className="focus-button"
            type="button"
            onClick={() =>
              void notesApi
                .open({ kind: "card", id: current.id, expectedScope: current.expectedScope })
                .catch((e) => setError(String(e)))
            }
          >
            Open linked card
          </button>
          <button
            className="focus-button"
            type="button"
            onClick={() =>
              void choose(null).then((ok) => {
                if (ok) close();
              })
            }
          >
            Unlink card
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="island-error">
          {error}
        </p>
      )}
      {!data && !error && <p className="island-muted">Loading cards…</p>}
      {data && cards.length === 0 && (
        <p className="island-muted">No cards in this workspace. Add a card in Notes to link it.</p>
      )}
      {cards.map((c) => (
        <button
          type="button"
          className="focus-card-option"
          key={`${c.scope?.key ?? "local"}:${c.value.id}`}
          onClick={() => {
            void choose({ id: c.value.id, expectedScope: c.scope ?? null }).then((ok) => {
              if (ok) close();
            });
          }}
        >
          <span className="island-mono">{c.value.ref || "Local note"}</span>
          <span className="island-ellipsis">{c.value.title || "Untitled card"}</span>
        </button>
      ))}
    </div>
  );
}
export function FocusTimer({ peek = false }: { peek?: boolean }) {
  const { snapshot, error, busy, act } = useTimer(),
    [custom, setCustom] = useState(false),
    [picker, setPicker] = useState(false);
  if (!snapshot)
    return (
      <section className="focus-loading">
        <h1 className="island-sr-only">Focus timer</h1>
        <p role={error ? "alert" : "status"} className={error ? "island-error" : "island-muted"}>
          {error || "Loading timer…"}
        </p>
      </section>
    );
  const s = snapshot.session,
    remaining = s?.remainingS ?? snapshot.config.focusS,
    planned = s?.plannedS ?? snapshot.config.focusS,
    phase = s?.phase === "break" ? "Break" : snapshot.config.label;
  const message = error || snapshot.error || snapshot.shortcutError;
  const card = snapshot.linkedCard;
  if (peek)
    return (
      <section className="island-peek-content focus-peek" aria-label="Focus timer">
        <h1 className="island-sr-only">Focus timer</h1>
        <div className="island-row focus-peek-header">
          <IslandAsset group="peek" name="iconTimer" />
          <div className="focus-titles island-spacer">
            <strong className="island-ellipsis">
              {phase}
              {card ? ` · ${card.title}` : ""}
            </strong>
            <span className="island-muted">
              {s?.status === "paused" ? "Paused · " : s?.status === "ended" ? "Complete · " : ""}
              Round {s?.round ?? 1} of {snapshot.config.rounds}
              {s?.deadlineMs && s.status === "running"
                ? ` · ${s.phase === "focus" && snapshot.config.breakS > 0 ? "break" : "ends"} at ${new Date(s.deadlineMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                : ""}
            </span>
          </div>
          <span className="focus-peek-digits">{duration(remaining)}</span>
          <Controls snapshot={snapshot} peek act={act} busy={busy} />
        </div>
        <div className="island-progress">
          <i style={{ width: `${(remaining / Math.max(1, planned)) * 100}%` }} />
        </div>
        {message && (
          <p role="alert" className="island-error">
            {message}
          </p>
        )}
      </section>
    );
  return (
    <section className="focus-timer" aria-label="Focus timer">
      <h1 className="island-sr-only">Focus timer</h1>
      <div className="focus-body">
        <Ring remaining={remaining} planned={planned} />
        <div className="focus-session">
          <div className="focus-titles">
            <h2>
              {phase} · round {s?.round ?? 1} of {snapshot.config.rounds}
            </h2>
            <div className="focus-card-line">
              <button
                className="focus-link"
                type="button"
                title={card ? "Change linked card" : "Link a card"}
                onClick={() => setPicker((v) => !v)}
              >
                <IslandAsset group="10:433" name="iconLink" />
                <span>
                  {card ? (
                    <>
                      <span className="island-mono">{card.reference || "Local note"}</span> ·{" "}
                      {card.title}
                    </>
                  ) : snapshot.linkUnavailable ? (
                    "Linked card unavailable"
                  ) : (
                    "Link a card"
                  )}
                </span>
              </button>
            </div>
          </div>
          <div className="focus-presets" role="group" aria-label="Timer presets">
            {presets.map((p) => (
              <PresetChip
                key={p.preset}
                disabled={busy}
                surface="island"
                selected={snapshot.config.preset === p.preset}
                title={
                  s ? "Stops the current timer and prepares this preset" : "Prepare this preset"
                }
                onClick={() => {
                  void act({ kind: "configure", config: { ...snapshot.config, ...p } });
                  setCustom(false);
                }}
              >
                {p.preset.replace("/", " / ")}
              </PresetChip>
            ))}
            <PresetChip
              surface="island"
              selected={snapshot.config.preset === "custom"}
              onClick={() => setCustom((v) => !v)}
            >
              Custom
            </PresetChip>
          </div>
          <div className="focus-controls">
            <Controls snapshot={snapshot} peek={false} act={act} busy={busy} />
            <span className="island-spacer" />
            <span className="island-muted focus-log-label">Log time to Tack · v2.1</span>
            <Toggle
              checked={false}
              disabled
              layout="control"
              label="Log time to Tack (v2.1)"
              onChange={() => {}}
            />
          </div>
        </div>
      </div>
      {custom && (
        <Custom
          config={snapshot.config}
          save={async (config) => {
            const ok = await act({ kind: "configure", config });
            if (ok) setCustom(false);
            return ok;
          }}
          close={() => setCustom(false)}
        />
      )}
      {picker && (
        <CardPicker
          current={card}
          close={() => setPicker(false)}
          choose={(card) => act({ kind: "link", card })}
        />
      )}
      {message && (
        <p role="alert" className="island-error">
          {message}
        </p>
      )}
    </section>
  );
}
function Custom({
  config,
  save,
  close,
}: {
  config: TimerConfig;
  save: (config: TimerConfig) => Promise<boolean>;
  close: () => void;
}) {
  const [focus, setFocus] = useState(String(config.focusS / 60)),
    [rest, setRest] = useState(String(config.breakS / 60)),
    [rounds, setRounds] = useState(String(config.rounds)),
    [label, setLabel] = useState(config.label);
  return (
    <form
      className="focus-custom"
      aria-label="Custom timer"
      onSubmit={(e) => {
        e.preventDefault();
        void save({
          ...config,
          preset: "custom",
          focusS: Number(focus) * 60,
          breakS: Number(rest) * 60,
          rounds: Number(rounds),
          label,
        });
      }}
    >
      <label>
        Focus minutes
        <input
          type="number"
          required
          min={1}
          max={1440}
          step={1}
          value={focus}
          onChange={(e) => setFocus(e.currentTarget.value)}
        />
      </label>
      <label>
        Break minutes
        <input
          type="number"
          required
          min={0}
          max={120}
          step={1}
          value={rest}
          onChange={(e) => setRest(e.currentTarget.value)}
        />
      </label>
      <label>
        Rounds
        <input
          type="number"
          required
          min={1}
          max={12}
          step={1}
          value={rounds}
          onChange={(e) => setRounds(e.currentTarget.value)}
        />
      </label>
      <label className="focus-custom-label">
        Label
        <input
          required
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
      </label>
      <button className="focus-button" type="submit">
        Use custom timer
      </button>
      <button className="focus-button" type="button" onClick={close}>
        Cancel
      </button>
    </form>
  );
}
