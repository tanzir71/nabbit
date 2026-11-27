import type { NoteColor } from "../../components/NoteCard";
export type NotePriority = "inbox" | "now" | "next" | "later";
export type NoteKind = "note" | "checklist" | "bookmark" | "task";
export interface NoteItem {
  id: string;
  text: string;
  checked: boolean;
  [key: string]: unknown;
}
// Retain fields that this client does not yet understand, including nested ones.
export interface CardValue {
  id: string;
  revision: number;
  assigneeId: string | null;
  priority: NotePriority;
  ref: string;
  doneWhen: string;
  frontmatter: string;
  kind: NoteKind;
  title: string;
  body: string;
  url: string;
  labels: string[];
  items: NoteItem[];
  attachmentIds: string[];
  pinned: boolean;
  archived: boolean;
  trashedAt: string | null;
  completed: boolean;
  status?: "open" | "active" | "blocked" | "done";
  color: NoteColor;
  rank: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  sourceId: string | null;
  [key: string]: unknown;
}
export interface StoredNote {
  value: CardValue;
  localOnly: boolean;
}
export interface NoteDraft {
  title: string;
  body?: string;
  kind?: NoteKind;
  url?: string;
  items?: string[];
  labels?: string[];
  priority?: NotePriority;
  color?: NoteColor;
}
export type NotePatch = Partial<
  Pick<
    CardValue,
    | "title"
    | "body"
    | "kind"
    | "url"
    | "items"
    | "labels"
    | "priority"
    | "color"
    | "pinned"
    | "archived"
    | "trashedAt"
    | "completed"
    | "status"
  >
>;
export type NotesView = "notes" | "archive" | "trash";
export function visibleNotes(
  cards: StoredNote[],
  view: NotesView,
  priority: NotePriority | "all",
  label: string,
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase();
  return cards
    .filter(
      ({ value: c }) =>
        (view === "trash" ? !!c.trashedAt : !c.trashedAt && c.archived === (view === "archive")) &&
        (priority === "all" || c.priority === priority) &&
        (!label || c.labels.includes(label)) &&
        (!needle ||
          [c.title, c.body, c.url, c.ref, ...c.labels, ...c.items.map((i) => i.text)]
            .join("\n")
            .toLocaleLowerCase()
            .includes(needle)),
    )
    .sort((a, b) =>
      a.value.rank < b.value.rank
        ? -1
        : a.value.rank > b.value.rank
          ? 1
          : a.value.id.localeCompare(b.value.id),
    );
}
