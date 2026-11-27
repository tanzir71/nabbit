// Browser controls -> production link/import services -> SQLite -> real fake Tack.
// Picker, clipboard and shell are fixture providers; no user source is inspected.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { URL } from "node:url";
export async function verifyLinksAcceptance({
  page,
  context,
  origin,
  info,
  data,
  installMockIpc,
  installBridge,
  call,
  inspect,
  wait,
  checks,
}) {
  const fixture = await call("test.links");
  // Execute the upstream DOM walk itself, with only its card constructor stubbed.
  const source = await readFile(
    new URL("../progress/v2/M9/v49-upstream-bookmarks.txt", import.meta.url),
    "utf8",
  );
  const upstream = ts.transpile(
    source
      .replace(
        'import { draft } from "./types";',
        "function draft(title, body, kind) { return {card:{title,body,kind}}; }",
      )
      .replace("export function", "function"),
  );
  const parity = await page.evaluate(
    ({ code, html }) => {
      const parse = new globalThis.Function(`${code};return parseBookmarks;`)();
      return parse(html).map(({ card }) => ({
        title: card.title,
        url: card.url,
        labels: card.labels.filter(
          (l) =>
            !["bookmarks menu", "bookmarks bar", "bookmarks toolbar"].includes(l.toLowerCase()),
        ),
        createdAt: card.createdAt,
      }));
    },
    { code: upstream, html: fixture.html },
  );
  assert.deepEqual(parity, fixture.nativeHtml);
  checks.push(
    "Native HTML5 import matches the pinned Tack DOMParser walk for nested folders, dates, entities and bookmarklet rejection, with Nabbit root-label filtering",
  );
  const scope = (await call("get_notes_state")).scope;
  const editorUrl = `${fixture.titleUrl}/editor`;
  const editorRequest = {
    requestId: globalThis.crypto.randomUUID(),
    expectedScope: scope,
    draft: { kind: "bookmark", title: editorUrl, url: editorUrl },
    patch: {},
    reminders: [],
  };
  await call("notes_open", { intent: { kind: "new", request: editorRequest } });
  await page.reload({ waitUntil: "domcontentloaded" });
  const editor = page.getByRole("dialog", { name: "Note editor", exact: true });
  await editor.waitFor();
  await editor.getByRole("button", { name: "Save link", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  const editorSaved = (
    await call("get_note_editor", { id: editorRequest.requestId, expectedScope: scope })
  ).note;
  assert.equal(editorSaved.value.title, "Owned fixture title & links");
  assert.equal(editorSaved.value.url, editorUrl);
  checks.push(
    "New bookmark editor uses Save link, resolves its automatic title through the production metadata service and preserves the address",
  );

  const titleUrl = `${fixture.titleUrl}?utm_source=acceptance#original`;
  const packet = {
    requestId: globalThis.crypto.randomUUID(),
    expectedScope: scope,
    draft: { kind: "bookmark", title: titleUrl, url: titleUrl },
    patch: {},
    reminders: [],
  };
  const saved = await call("save_link", { request: packet });
  assert.equal(saved.value.title, "Owned fixture title & links");
  assert.equal(saved.value.url, titleUrl);
  assert.equal((await call("save_link", { request: packet })).value.id, saved.value.id);
  const duplicate = await call("save_link", {
    request: {
      ...packet,
      requestId: globalThis.crypto.randomUUID(),
      draft: { ...packet.draft, url: `${fixture.titleUrl}?fbclid=tracking` },
    },
  });
  assert.equal(duplicate.value.id, saved.value.id);
  await wait(async () => (await inspect()).sync.pending === 0, "link reference acknowledgement");
  checks.push(
    "Bounded cookie-free metadata GET prefers OG title; scoped save preserves the original address and both request replay and normalized duplicate capture return one card",
  );

  const copiedContext = await context
    .browser()
    .newContext({ viewport: { width: 460, height: 680 }, locale: "en-US", timezoneId: "UTC" });
  const copyProblems = [];
  try {
    await copiedContext.route("**/*", (route) => {
      const target = new URL(route.request().url());
      if ([origin, info.url].includes(target.origin)) return route.continue();
      copyProblems.push(target.origin);
      return route.abort();
    });
    const copyUrl = `${fixture.titleUrl}/copied?utm_source=copy#section`;
    const copiedData = globalThis.structuredClone(data);
    copiedData.settings.lastTab = "clipboard";
    copiedData.clipboard = [
      { ...copiedData.clipboard[1], content: copyUrl, preview: copyUrl, pinned: false },
    ];
    await copiedContext.addInitScript({
      content: `(${installMockIpc.toString()})(${JSON.stringify({ data: copiedData, label: "main", theme: "light" })});(${installBridge.toString()})(${JSON.stringify(info)});`,
    });
    const copiedPage = await copiedContext.newPage();
    copiedPage.on("pageerror", (e) => copyProblems.push(e.message));
    await copiedPage.goto(origin, { waitUntil: "domcontentloaded" });
    const row = copiedPage.getByRole("region", { name: "Copied link actions" });
    await row.getByRole("button", { name: "Save link", exact: true }).click();
    await wait(
      async () => (await inspect()).notes.find((n) => n.value.url === copyUrl),
      "clipboard link persisted",
    );
    const copiedNote = (await inspect()).notes.find((n) => n.value.url === copyUrl);
    assert.equal(copiedNote.value.title, "Owned fixture title & links");
    await wait(
      () => row.getByRole("button", { name: "Clean link", exact: true }).isEnabled(),
      "copy save acknowledged",
    );
    await row.getByRole("button", { name: "Clean link", exact: true }).click();
    await row.getByText("Clean link copied", { exact: true }).waitFor();
    const copiedCalls = (await copiedPage.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot()))
      .calls;
    assert(
      copiedCalls.some(
        (c) =>
          c.command === "plugin:clipboard-manager|write_text" &&
          c.args.text === copyUrl.replace("?utm_source=copy", ""),
      ),
    );
    assert.equal(
      (await call("get_note_editor", { id: copiedNote.value.id, expectedScope: scope })).note.value
        .url,
      copyUrl,
    );
    assert.deepEqual(copyProblems, []);
    checks.push(
      "Actual clipboard context row saves through the production Rust metadata/store service; Clean link reaches only the recording clipboard provider and keeps the original saved address",
    );
  } finally {
    await copiedContext.close();
  }
  await call("notes_open", { intent: { kind: "import" } });
  await page.reload({ waitUntil: "domcontentloaded" });
  const sheet = page.getByRole("dialog", { name: "Import bookmarks", exact: true });
  await sheet.waitFor();
  const primary = sheet.getByRole("button", { name: "Import 56 links", exact: true });
  await primary.waitFor();
  await wait(() => primary.isEnabled(), "import preview");
  const paths = await sheet.locator("details").textContent();
  assert(paths.includes("Local State") && paths.includes("places.sqlite-wal"));
  assert(!paths.includes("Cookies") && !paths.includes("Login Data") && !paths.includes("History"));
  assert.equal(await sheet.getByRole("checkbox").count(), 5);
  await sheet.getByRole("button", { name: "Bookmarks file (.html)…", exact: false }).click();
  await wait(() => primary.isEnabled(), "HTML preview");
  await sheet.getByRole("checkbox", { name: /Firefox/ }).check();
  await wait(() => primary.isEnabled(), "Firefox selection preview");
  await primary.click();
  await sheet.getByRole("heading", { name: "Imported 56 links", exact: true }).waitFor();
  const result = (await call("bookmarks_history", { expectedScope: scope }))[0];
  assert.equal(result.imported, 56);
  assert(result.duplicates >= 10);
  assert.equal(result.skipped, 6);
  const imported = (await inspect()).notes.filter((n) =>
    n.value.url.startsWith("https://example.invalid/doc/"),
  );
  assert.equal(imported.length, 56);
  for (const note of imported) {
    assert.deepEqual(note.value.labels, ["Design", "Fonts"]);
    assert.equal(note.value.priority, "later");
    assert.equal(note.value.createdAt, "2024-01-01T00:00:00.000Z");
  }
  await wait(async () => (await inspect()).sync.pending === 0, "56 imported links synchronized");
  assert((await inspect()).batches.every((n) => n <= 50));
  assert.equal(
    (await call("bookmarks_commit", { planId: result.id, expectedScope: scope })).imported,
    56,
  );
  assert.equal(
    (await inspect()).notes.filter((n) => n.value.url.startsWith("https://example.invalid/doc/"))
      .length,
    56,
  );
  checks.push(
    "Import sheet reads five isolated browser profiles plus an injected HTML picker, displays exact allowlisted files, defaults Later/folder labels/dedupe, imports 56 dated links once and syncs in at most 50 mutations per request",
  );
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await call("notes_open", { intent: { kind: "links" } });
  await page.reload({ waitUntil: "domcontentloaded" });
  const panel = page.getByRole("region", { name: "Saved links" });
  await panel.waitFor();
  const search = panel.getByRole("textbox", { name: "Search links" });
  await search.fill("example.invalid");
  assert.equal(await panel.locator(".link-row").count(), 56);
  await panel.getByRole("checkbox", { name: "Select Fixture link 00", exact: true }).check();
  await panel.getByRole("checkbox", { name: "Select Fixture link 01", exact: true }).check();
  await panel.getByRole("button", { name: "Open all", exact: true }).click();
  await wait(async () => (await call("test.links")).opened.length === 2, "recorded shell provider");
  await panel.getByRole("button", { name: "Copy Fixture link 00", exact: true }).click();
  assert(
    (await page.evaluate(() => globalThis.__NABBIT_CAPTURE__.snapshot())).calls.some(
      (c) =>
        c.command === "plugin:clipboard-manager|write_text" &&
        c.args.text === "https://example.invalid/doc/0",
    ),
  );
  await panel.getByRole("button", { name: "Label", exact: true }).click();
  await panel.getByRole("textbox", { name: "Labels for selected links" }).fill("Reading");
  await panel.getByRole("button", { name: "Apply labels", exact: true }).click();
  await wait(
    async () =>
      (await inspect()).notes.filter((n) => n.value.labels.includes("Reading")).length === 2,
    "atomic bulk label",
  );
  await panel.getByRole("button", { name: "#Reading", exact: true }).click();
  assert.equal(await panel.locator(".link-row").count(), 2);
  await panel.getByRole("checkbox", { name: "Select Fixture link 00", exact: true }).check();
  await panel.getByRole("button", { name: "Archive", exact: true }).click();
  await wait(
    async () =>
      (await inspect()).notes.find((n) => n.value.title === "Fixture link 00").value.archived,
    "bulk archive",
  );
  checks.push(
    "Links UI searches domains, filters folder labels and applies guarded bulk labels/archive; Open all and Copy reach recording providers without opening browsers or touching the OS clipboard",
  );
  await call("bookmarks_undo", { id: result.id, expectedScope: scope });
  await wait(async () => (await inspect()).sync.pending === 0, "group undo synchronized");
  const trashed = (await inspect()).notes.filter((n) =>
    n.value.url.startsWith("https://example.invalid/doc/"),
  );
  assert.equal(trashed.length, 56);
  assert(trashed.every((n) => n.value.trashedAt));
  assert(trashed.find((n) => n.value.title === "Fixture link 00").value.labels.includes("Reading"));
  assert.equal(await call("bookmarks_undo", { id: result.id, expectedScope: scope }), 0);
  checks.push(
    "One durable undo group trashes all 56 imported links through real sync, preserves subsequent labels/archive and is idempotent",
  );
  await call("notes_open", { intent: { kind: "all" } });
  await page.reload({ waitUntil: "domcontentloaded" });
}
