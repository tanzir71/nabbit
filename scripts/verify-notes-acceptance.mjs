// Additional V4.8 UI -> production store/service -> owned fake assertions.
// Window identity is an explicit test-only seam; native HWNDs have a separate smoke.
import assert from "node:assert/strict";
export async function verifyNotesAcceptance({
  page,
  context,
  origin,
  info,
  data,
  call,
  inspect,
  wait,
  checks,
  installMockIpc,
  installBridge,
}) {
  const capture = page.getByRole("textbox", { name: "Note title", exact: true });
  await capture.fill("Unlabelled acceptance");
  await capture.press("Enter");
  await wait(async () => (await capture.inputValue()) === "", "unlabelled capture");
  await wait(async () => (await inspect()).sync.pending === 0, "server ref echo");
  let note = (await inspect()).notes.find((n) => n.value.title === "Unlabelled acceptance");
  assert.match(note.value.ref, /^tck-[1-9][0-9]*$/);
  const id = note.value.id;
  await call("test.remote_edit", {
    id,
    patch: {
      futureServer: { nested: [1, "keep", { enabled: true }] },
      kind: "checklist",
      items: [
        { id: "stable-acceptance-item", text: "Ship acceptance", checked: false, futureItem: 42 },
      ],
    },
  });
  await call("tack_sync_now");
  await wait(
    async () => (await inspect()).notes.find((n) => n.value.id === id)?.value.futureServer,
    "unknown server fields pulled",
  );
  await page.getByRole("button", { name: "Unlabelled acceptance", exact: true }).click();
  const editor = () => page.getByRole("dialog", { name: "Note editor", exact: true });
  await editor().getByLabel("Note body", { exact: true }).fill("Edited with future fields intact");
  await editor().getByLabel("Complete checklist item 1", { exact: true }).check();
  await editor().getByRole("button", { name: "Blue colour", exact: true }).click();
  await editor().getByRole("button", { name: "Pin note", exact: true }).click();
  await editor().getByRole("button", { name: "Add", exact: true }).click();
  await editor().getByLabel("Add label", { exact: true }).fill("Acceptance");
  await editor().getByRole("button", { name: "Add label", exact: true }).click();
  await editor().getByRole("button", { name: "Save note", exact: true }).click();
  await editor().waitFor({ state: "detached" });
  await wait(async () => (await inspect()).sync.pending === 0, "CRUD ack");
  note = (await call("get_note_editor", { id, expectedScope: note.scope })).note;
  assert.equal(note.value.body, "Edited with future fields intact");
  assert.equal(note.value.items[0].checked, true);
  assert.equal(note.value.items[0].id, "stable-acceptance-item");
  assert.equal(note.value.items[0].futureItem, 42);
  assert.deepEqual(note.value.futureServer, { nested: [1, "keep", { enabled: true }] });
  assert.equal(note.value.color, "blue");
  assert.equal(note.value.pinned, true);
  assert.deepEqual(note.value.labels, ["Acceptance"]);
  checks.push(
    "Unlabelled UI capture receives a real server tck-N; editing/checking/recolouring/labelling/pinning preserves unknown nested card and checklist fields after HTTP acknowledgement",
  );
  await page.getByRole("button", { name: "Unlabelled acceptance", exact: true }).click();
  await editor().getByRole("button", { name: "Archive note", exact: true }).click();
  await editor().waitFor({ state: "detached" });
  await wait(async () => (await inspect()).sync.pending === 0, "archive ack");
  note = (await call("get_note_editor", { id, expectedScope: note.scope })).note;
  assert.equal(note.value.archived, true);
  // Open through the same durable navigation intent used by island/editor handoff.
  await call("notes_open", { intent: { kind: "card", id, expectedScope: note.scope } });
  await page.reload({ waitUntil: "domcontentloaded" });
  await editor().waitFor();
  await editor().getByRole("button", { name: "Move note to Trash", exact: true }).click();
  await editor().waitFor({ state: "detached" });
  await wait(async () => (await inspect()).sync.pending === 0, "trash ack");
  note = (await call("get_note_editor", { id, expectedScope: note.scope })).note;
  assert(note.value.trashedAt);
  await call("notes_open", { intent: { kind: "card", id, expectedScope: note.scope } });
  await page.reload({ waitUntil: "domcontentloaded" });
  await editor().waitFor();
  await editor().getByRole("button", { name: "Restore note", exact: true }).click();
  await editor().waitFor({ state: "detached" });
  await wait(async () => (await inspect()).sync.pending === 0, "restore ack");
  note = (await call("get_note_editor", { id, expectedScope: note.scope })).note;
  assert.equal(note.value.trashedAt, null);
  checks.push(
    "Archive, trash and restore UI actions persist and round trip through the owned fake, including archived-card editor navigation",
  );
  const label = await call("open_sticky", { id, expectedScope: note.scope });
  assert.equal(await call("open_sticky", { id, expectedScope: note.scope }), label);
  const sticky = await context.newPage();
  await sticky.addInitScript({
    content: `(${installMockIpc.toString()})(${JSON.stringify({ data, label, theme: "light" })});(${installBridge.toString()})(${JSON.stringify({ ...info, window: label })});`,
  });
  try {
    await sticky.goto(`${origin}/sticky.html`, { waitUntil: "domcontentloaded" });
    await sticky
      .getByLabel("Checklist item 1", { exact: true })
      .fill("Autosaved from sticky into Tack");
    await sticky.getByRole("button", { name: "Close sticky note", exact: true }).focus();
    await wait(async () => {
      const s = await inspect();
      return (
        s.sync.pending === 0 &&
        s.notes.find((n) => n.value.id === id)?.value.items[0].text ===
          "Autosaved from sticky into Tack"
      );
    }, "sticky autosave through production service");
    note = (await call("get_note_editor", { id, expectedScope: note.scope })).note;
    assert.deepEqual(note.value.futureServer, { nested: [1, "keep", { enabled: true }] });
    assert.equal(note.value.items[0].futureItem, 42);
    await page.reload({ waitUntil: "domcontentloaded" });
    checks.push(
      "Sticky UI autosaves via guarded production SQLite/outbox/Service/HTTP; main editor reads the same card and unknown fields survive (window lifecycle remains a test seam)",
    );
  } finally {
    await sticky.close();
    await page.bringToFront();
  }
}
