import { invoke } from "@tauri-apps/api/core";
export interface MediaTimeline {
  positionS: number;
  durationS: number;
  updatedAtMs: number;
  rate: number;
  startTicks: number;
}
export interface MediaSession {
  id: string;
  app: string;
  title: string;
  artist: string;
  playing: boolean;
  controls: {
    play: boolean;
    pause: boolean;
    toggle: boolean;
    previous: boolean;
    next: boolean;
    seek: boolean;
  };
  timeline: MediaTimeline | null;
  art: string | null;
}
export interface MediaSnapshot {
  revision: number;
  sessions: MediaSession[];
  selected: string | null;
  volume: { percent: number; muted: boolean } | null;
  error: string | null;
}
export type MediaAction =
  | { kind: "toggle" | "previous" | "next"; id: string }
  | { kind: "seek"; id: string; positionS: number }
  | { kind: "volumeStep"; direction: -1 | 1; fine: boolean }
  | { kind: "volume"; percent: number }
  | { kind: "mute"; muted: boolean };
export const mediaApi = {
  snapshot: () => invoke<MediaSnapshot>("media_snapshot"),
  select: (id: string) => invoke<void>("media_select", { id }),
  action: (action: MediaAction) => invoke<void>("media_action", { action }),
};
