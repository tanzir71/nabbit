// Synthetic design fixtures, not a connected Tack account or allocated server refs.
export function notesFixture() {
  const make = (id, patch) => ({
    localOnly: true,
    value: {
      id,
      revision: 0,
      assigneeId: null,
      priority: "inbox",
      ref: "",
      doneWhen: "",
      frontmatter: "",
      kind: "note",
      title: "",
      body: "",
      url: "",
      labels: [],
      items: [],
      attachmentIds: [],
      pinned: true,
      archived: false,
      trashedAt: null,
      completed: false,
      color: "default",
      rank: `a${id}`,
      projectId: null,
      createdAt: "2026-11-27T04:00:00.000Z",
      updatedAt: "2026-11-27T04:00:00.000Z",
      sourceId: null,
      ...patch,
    },
  });
  return [
    make("0", {
      title: "Launch checklist",
      kind: "checklist",
      color: "green",
      labels: ["Build"],
      ref: "tck-24",
      items: [
        { id: "dpi", text: "Verify island at 150% DPI", checked: true },
        { id: "demo", text: "Record demo GIF", checked: false },
        { id: "release", text: "Write release notes", checked: false },
      ],
    }),
    make("1", {
      title: "Island idea",
      body: "Scroll on the pill to change volume; middle-click toggles play.",
      color: "blue",
      labels: ["Ideas"],
      ref: "tck-27",
    }),
    make("2", {
      title: "Name check",
      body: '"Nabbit" is also a game character. Shortlist alternates before public release.',
      color: "pink",
      labels: ["Ideas"],
      ref: "tck-35",
    }),
    make("3", {
      title: "Tauri window docs",
      kind: "bookmark",
      url: "https://v2.tauri.app/reference/javascript/api",
      labels: ["Ideas"],
      ref: "tck-31",
    }),
  ];
}
