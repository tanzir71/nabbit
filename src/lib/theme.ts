export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
const cacheKey = "nabbit.theme.v1";
export const normalizeThemePreference = (value: unknown): ThemePreference =>
  value === "light" || value === "dark" ? value : "system";

export function cachedThemePreference(): ThemePreference {
  try {
    return normalizeThemePreference(localStorage.getItem(cacheKey));
  } catch {
    return "system";
  }
}
export function initializeTheme() {
  const preference = cachedThemePreference();
  document.documentElement.dataset.theme =
    preference === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
}

export interface NativeThemeSource {
  current: () => Promise<Theme | null>;
  listen: (receive: (theme: Theme) => void) => Promise<() => void>;
}
export interface ThemeMediaSource {
  readonly matches: boolean;
  addEventListener: (type: "change", receive: (event: { matches: boolean }) => void) => void;
  removeEventListener: (type: "change", receive: (event: { matches: boolean }) => void) => void;
}
export function connectTheme(
  root: HTMLElement,
  media: ThemeMediaSource,
  preference: ThemePreference,
  native?: NativeThemeSource,
) {
  let system: Theme = media.matches ? "dark" : "light";
  let closed = false,
    revision = 0;
  let stopNative: (() => void) | undefined;
  const apply = () => {
    if (closed) return;
    const resolved = preference === "system" ? system : preference;
    if (root.dataset.theme !== resolved) root.dataset.theme = resolved;
  };
  const receive = (theme: Theme) => {
    revision++;
    system = theme;
    apply();
  };
  const changed = (event: { matches: boolean }) => receive(event.matches ? "dark" : "light");
  media.addEventListener("change", changed);
  apply();
  if (native)
    void (async () => {
      const stop = await native.listen(receive);
      if (closed) {
        stop();
        return;
      }
      stopNative = stop;
      const requestedAt = revision;
      const theme = await native.current();
      if (!closed && theme && revision === requestedAt) {
        system = theme;
        apply();
      }
    })().catch(() => {
      /* The browser media source remains available. */
    });
  return {
    setPreference(value: ThemePreference) {
      preference = normalizeThemePreference(value);
      try {
        localStorage.setItem(cacheKey, preference);
      } catch {
        /* SQLite remains authoritative. */
      }
      apply();
    },
    close() {
      closed = true;
      media.removeEventListener("change", changed);
      stopNative?.();
    },
  };
}
