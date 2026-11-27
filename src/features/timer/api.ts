import { invoke } from "@tauri-apps/api/core";
import type { NotesContext } from "../notes/types";
export interface CardLink {
  id: string;
  expectedScope: NotesContext | null;
}
export interface TimerConfig {
  preset: "25/5" | "50/10" | "90" | "custom";
  focusS: number;
  breakS: number;
  rounds: number;
  label: string;
  card: CardLink | null;
}
export interface TimerSnapshot {
  revision: number;
  generation: number;
  config: TimerConfig;
  session: {
    id: string;
    phase: "focus" | "break";
    status: "running" | "paused" | "ended";
    round: number;
    plannedS: number;
    remainingS: number;
    deadlineMs: number | null;
  } | null;
  linkedCard: (CardLink & { reference: string; title: string }) | null;
  linkUnavailable: boolean;
  shortcutError: string | null;
  error: string | null;
}
export type TimerAction =
  | { kind: "start" | "pause" | "resume" | "stop" }
  | { kind: "configure"; config: TimerConfig }
  | { kind: "link"; card: CardLink | null };
export const timerApi = {
  snapshot: () => invoke<TimerSnapshot>("timer_snapshot"),
  action: (expectedGeneration: number, action: TimerAction) =>
    invoke<TimerSnapshot>("timer_action", { request: { expectedGeneration, action } }),
  view: (lease: string, active: boolean) => invoke<void>("timer_view", { lease, active }),
};
