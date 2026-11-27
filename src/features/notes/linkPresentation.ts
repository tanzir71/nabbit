export function linkDomain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
export function linkDate(at: string) {
  const d = new Date(at);
  return Number.isFinite(+d)
    ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    : "";
}
export function isVideo(url: string) {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|dailymotion\.com)$/.test(
      new URL(url).hostname,
    );
  } catch {
    return false;
  }
}

export function newestClipboardEntry<T extends { lastUsedAt: string }>(
  entries: T[],
): T | undefined {
  return entries.reduce<T | undefined>(
    (newest, entry) =>
      !newest || Date.parse(entry.lastUsedAt) > Date.parse(newest.lastUsedAt) ? entry : newest,
    undefined,
  );
}
