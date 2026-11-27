// Port of Tack ad06dc0fb279357d6e3d82b758ad233239752cce, project-priority/src/capture.ts and cards.ts.
// Parsing and wall-time conversion intentionally preserve upstream behavior.
import type { NoteKind, NotePriority } from "./types";
import type { ReminderValue } from "./api";
export type Capture = {
  title: string;
  kind: NoteKind | "repo";
  priority: NotePriority;
  labels: string[];
  project: string;
  assignee?: string;
  assigneeId?: string | null;
  reminder?: { at: string; repeat: ReminderValue["repeat"]; timeZone: string };
  tokens: string[];
  url: string;
};
type Reminder = ReminderValue;
type Priority = NotePriority;

export function parts(date: Date, zone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}

export function inZone(wall: Date, zone: string) {
  let instant = wall.getTime();
  for (let i = 0; i < 4; i++) {
    const p = parts(new Date(instant), zone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const delta = wall.getTime() - represented;
    if (!delta) break;
    instant += delta;
  }
  return new Date(instant);
}

export function parseCapture(
  input: string,
  clock = new Date(),
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Capture {
  let title = input.trim();
  const tokens: string[] = [];
  let assignee: string | undefined;
  title = title.replace(/(^|\s)@([\p{L}\p{N}_.-]+)(?=\s|$)/gu, (_, space: string, name: string) => {
    assignee = name;
    tokens.push(`@${name}`);
    return space;
  });
  let priority: Priority = "inbox";
  title = title.replace(/(?:^|\s)!(inbox|now|next|later|[123])\b/gi, (_, value: string) => {
    priority = ({ "1": "now", "2": "next", "3": "later" }[value] ??
      value.toLowerCase()) as Priority;
    tokens.push(`!${value}`);
    return " ";
  });
  const labels: string[] = [];
  title = title.replace(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu, (_, value: string) => {
    labels.push(value);
    tokens.push(`#${value}`);
    return " ";
  });
  let project = "";
  title = title.replace(/(?:^|\s)\+([\p{L}\p{N}_-]+)/gu, (_, value: string) => {
    project = value;
    tokens.push(`+${value}`);
    return " ";
  });
  // A possessive date word belongs to the title ("tomorrow’s ideas").
  const datePattern =
    /\b(every\s+(?:weekday|day|week|month)|yesterday|today|tomorrow|tonight|in\s+\d+\s+(?:minutes?|hours?|days?|weeks?)|(?:next\s+)?(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|\d{4}-\d{2}-\d{2})(?!['’]s\b)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/i;
  let reminder: Capture["reminder"];
  const match = title.match(datePattern);
  if (match) {
    const phrase = match[1].toLowerCase();
    const p = parts(clock, zone);
    const wall = new Date(Date.UTC(p.year, p.month - 1, p.day, 9));
    let repeat: Reminder["repeat"] = "none";
    if (phrase === "tomorrow") wall.setUTCDate(wall.getUTCDate() + 1);
    if (phrase === "yesterday") wall.setUTCDate(wall.getUTCDate() - 1);
    if (phrase === "tonight") wall.setUTCHours(20);
    const relative = phrase.match(/^in (\d+) (minute|hour|day|week)/);
    if (relative) {
      const n = +relative[1];
      if (relative[2] === "day" || relative[2] === "week")
        wall.setUTCDate(wall.getUTCDate() + n * (relative[2] === "week" ? 7 : 1));
      else {
        const future = parts(
          new Date(clock.getTime() + n * (relative[2] === "hour" ? 3600000 : 60000)),
          zone,
        );
        wall.setTime(
          Date.UTC(future.year, future.month - 1, future.day, future.hour, future.minute),
        );
      }
    }
    if (phrase.startsWith("every"))
      repeat = (
        {
          "every weekday": "weekdays",
          "every day": "daily",
          "every week": "weekly",
          "every month": "monthly",
        } as Record<string, Reminder["repeat"]>
      )[phrase];
    const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const weekday = dayNames.findIndex((name) => phrase.replace(/^next /, "").startsWith(name));
    if (weekday >= 0) {
      let delta = (weekday - wall.getUTCDay() + 7) % 7;
      if (!delta || phrase.startsWith("next ")) delta += delta ? 7 : 7;
      wall.setUTCDate(wall.getUTCDate() + delta);
    }
    if (/^\d{4}/.test(phrase)) {
      const [year, month, day] = phrase.split("-").map(Number);
      wall.setUTCFullYear(year, month - 1, day);
    }
    if (match[2]) {
      let hour = +match[2];
      const minute = +(match[3] ?? 0);
      if (match[4]) hour = (hour % 12) + (match[4].toLowerCase() === "pm" ? 12 : 0);
      if (hour > 23 || minute > 59)
        return {
          title: input.trim(),
          kind: "note",
          priority,
          labels,
          project,
          assignee,
          tokens,
          url: "",
        };
      wall.setUTCHours(hour, minute);
    }
    if (repeat !== "none" && inZone(wall, zone) <= clock)
      wall.setUTCDate(wall.getUTCDate() + (repeat === "weekly" ? 7 : repeat === "monthly" ? 0 : 1));
    if (repeat === "monthly" && inZone(wall, zone) <= clock)
      wall.setUTCMonth(wall.getUTCMonth() + 1);
    if (repeat === "weekdays")
      while ([0, 6].includes(wall.getUTCDay())) wall.setUTCDate(wall.getUTCDate() + 1);
    reminder = { at: inZone(wall, zone).toISOString(), repeat, timeZone: zone };
    tokens.push(match[0]);
    title = title.replace(match[0], " ");
  }
  const url = title.match(/https?:\/\/[^\s]+/i)?.[0] ?? "";
  let kind: Capture["kind"] = /^\[\]\s|^- \[ \]\s/.test(title)
    ? "checklist"
    : url
      ? "bookmark"
      : reminder || priority !== "inbox"
        ? "task"
        : "note";
  if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(url)) kind = "repo";
  title = title
    .replace(/^\[\]\s*|^- \[ \]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    title,
    kind,
    priority,
    labels: [...new Set(labels)],
    project,
    assignee,
    reminder,
    tokens,
    url,
  };
}
