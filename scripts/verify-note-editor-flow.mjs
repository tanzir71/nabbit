// Browser -> IPC forwarding seam -> actual Rust Service/SQLite -> Rust fake.
// All services are ephemeral loopback; production HTTPS validation is retained.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { preview } from "vite";
import { chromium } from "playwright";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { installMockIpc } from "./screenshots/mock-ipc.mjs";
import { verifyNotesAcceptance } from "./verify-notes-acceptance.mjs";

function installBridge(info) {
  const original = globalThis.__TAURI_INTERNALS__.invoke;
  const commands = [],
    captureRequests = [];
  const send = async (command, args = {}) => {
    commands.push(command);
    if (command === "capture_note") captureRequests.push(globalThis.structuredClone(args.request));
    const response = await globalThis.fetch(`${info.url}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nabbit-Test": info.token },
      body: JSON.stringify({ command, args, window: info.window ?? "main" }),
    });
    const result = await response.json();
    if (!result.ok) throw result.error;
    return result.value;
  };
  globalThis.__TAURI_INTERNALS__.invoke = (command, args) =>
    command.startsWith("tack_") ||
    command.startsWith("sticky_") ||
    command === "open_sticky" ||
    [
      "capture_note",
      "notes_open",
      "take_notes_intent",
      "get_notes_state",
      "list_note_cards",
      "create_note_card",
      "update_note_card",
      "get_note_editor",
      "save_note_editor",
    ].includes(command)
      ? send(command, args)
      : original(command, args);
  globalThis.__NABBIT_TACK_TEST__ = { commands, captureRequests, events: 0, streamError: false };
  void (async () => {
    const response = await globalThis.fetch(`${info.url}/events`, {
      headers: { "X-Nabbit-Test": info.token },
    });
    const reader = response.body.getReader(),
      decoder = new globalThis.TextDecoder();
    let buffered = "";
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      buffered += decoder.decode(item.value, { stream: true });
      let end;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const packet = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (packet.startsWith("data: ")) {
          const event = JSON.parse(packet.slice(6));
          globalThis.__NABBIT_TACK_TEST__.events++;
          globalThis.__NABBIT_CAPTURE__.emit(event.event, event.payload);
        }
      }
    }
  })().catch(() => {
    globalThis.__NABBIT_TACK_TEST__.streamError = true;
  });
}
const root = fileURLToPath(new URL("../", import.meta.url)),
  prefix = process.argv[2] ?? "v45-flow";
assert(/^[a-z0-9-]+$/.test(prefix));
const folder = resolve(root, "progress/v2/M9"),
  trial = resolve(root, `.tools/${prefix}-${randomUUID()}`),
  reportPath = resolve(folder, `${prefix}-flow.json`);
await mkdir(folder, { recursive: true });
await mkdir(trial, { recursive: true });
await stat(reportPath).then(
  () => {
    throw Error("Evidence prefix already exists");
  },
  (error) => assert.equal(error.code, "ENOENT"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const checks = [],
  problems = [];
let server,
  child,
  browser,
  context,
  page,
  info,
  logs = "",
  passed = false,
  failure;
const wait = async (action, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await action();
    if (value) return value;
    if (child && child.exitCode !== null) throw Error(`Owned Rust bridge exited while ${label}`);
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await setTimeout(100);
  }
};
const call = async (command, args = {}) => {
  const response = await globalThis.fetch(`${info.url}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nabbit-Test": info.token },
    body: JSON.stringify({ command, args }),
  });
  const result = await response.json();
  assert(result.ok, `Bridge control failed: ${command}`);
  return result.value;
};
const inspect = () => call("test.inspect");
try {
  server = await preview({
    root,
    configFile: resolve(root, "vite.config.ts"),
    preview: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
    logLevel: "error",
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  child = spawn(
    "cargo",
    [
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--lib",
      "tack::tests::browser_bridge::browser_connection_bridge",
      "--",
      "--ignored",
      "--exact",
      "--test-threads=1",
      "--nocapture",
    ],
    {
      cwd: root,
      env: { ...process.env, NABBIT_TACK_TEST_BRIDGE_DIR: trial, NABBIT_TACK_TEST_ORIGIN: origin },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (bytes) => {
    logs += bytes;
  });
  child.stderr.on("data", (bytes) => {
    logs += bytes;
  });
  await wait(
    async () => {
      try {
        info = JSON.parse(await readFile(resolve(trial, "info.json"), "utf8"));
        return true;
      } catch {
        return false;
      }
    },
    "bridge readiness",
    300000,
  );
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 460, height: 680 },
    colorScheme: "light",
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
  });
  await context.route("**/*", (route) => {
    const target = new URL(route.request().url());
    if ([origin, info.url].includes(target.origin)) return route.continue();
    problems.push(`Unexpected network: ${target.origin}`);
    return route.abort();
  });
  const data = fixtureData("tray-downloads");
  data.settings.lastTab = "notes";
  data.settings.engineAutoUpdate = false;
  await context.addInitScript({
    content: `(${installMockIpc.toString()})(${JSON.stringify({ data, label: "main", theme: "light" })});(${installBridge.toString()})(${JSON.stringify(info)});`,
  });
  page = await context.newPage();
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Local to upload", exact: true }).click();
  const editor = () => page.getByRole("dialog", { name: "Note editor", exact: true });
  await editor().getByLabel("Note body", { exact: true }).fill("A local editor draft");
  await editor().getByRole("button", { name: "Pink colour", exact: true }).click();
  await editor().getByRole("button", { name: "Pin note", exact: true }).click();
  await editor().getByRole("button", { name: "Add", exact: true }).click();
  await editor().getByLabel("Add label", { exact: true }).fill("Build");
  await editor().getByRole("button", { name: "Add label", exact: true }).click();
  await editor().getByRole("button", { name: "Add reminder", exact: true }).click();
  await editor().getByLabel("Reminder 1 repeat", { exact: true }).selectOption("weekdays");
  await editor().getByRole("button", { name: "Save note", exact: true }).click();
  await editor().waitFor({ state: "detached" });
  let observed = await inspect();
  assert.equal(observed.syncCalls, 0);
  assert.equal(observed.notes[0].value.body, "A local editor draft");
  assert.equal(observed.notes[0].value.color, "pink");
  assert(observed.notes[0].value.pinned);
  assert.deepEqual(observed.notes[0].value.labels, ["Build"]);
  const local = await call("get_note_editor", {
    id: observed.notes[0].value.id,
    expectedScope: null,
  });
  assert.equal(local.reminders.length, 1);
  assert.equal(local.reminders[0].value.repeat, "weekdays");
  checks.push(
    "Local-only editor saves body, colour, label, pin and reminder atomically through real Rust/SQLite with zero HTTP requests",
  );
  await page.getByRole("button", { name: "Local to upload", exact: true }).click();
  await editor().getByLabel("Note body", { exact: true }).fill("Unsaved text that must survive");
  await page.keyboard.press("Escape");
  await editor().getByText("Save your changes before closing?", { exact: false }).waitFor();
  await editor().getByRole("button", { name: "Keep editing", exact: true }).click();
  assert.equal(
    await editor().getByLabel("Note body", { exact: true }).inputValue(),
    "Unsaved text that must survive",
  );
  await editor().getByRole("button", { name: "Close editor", exact: true }).click();
  await editor().getByRole("button", { name: "Close without saving", exact: true }).click();
  observed = await inspect();
  assert.equal(observed.notes[0].value.body, "A local editor draft");
  checks.push("Escape and close require an explicit dirty-draft decision; discard does not save");
  await page.getByRole("button", { name: "Connect Tack", exact: true }).click();
  await page.getByLabel("Tack address", { exact: true }).fill(info.alias);
  await page.getByRole("button", { name: "Check server", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("Fixture");
  await page.getByLabel("Password", { exact: true }).fill("fixture-passphrase-42");
  await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Save your recovery code", exact: true }).waitFor();
  const recoveryCode = await page.getByLabel("Recovery code", { exact: true }).textContent();
  await page.getByLabel("I saved my recovery code", { exact: true }).check();
  await page.getByRole("button", { name: "I saved it — continue", exact: true }).click();
  await page.getByRole("checkbox", { name: /Upload 1 local note/ }).check();
  await page.getByRole("button", { name: "Start syncing", exact: true }).click();
  await wait(async () => {
    const s = await inspect();
    return s.enabled && s.sync.pending === 0 && s.sync.state === "upToDate";
  }, "uploaded card and reminder acknowledgement");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  observed = await inspect();
  const synced = observed.notes[0];
  assert.match(synced.value.ref, /^bui-[1-9][0-9]*$/);
  assert.notEqual(synced.value.id, local.note.value.id);
  const uploaded = await call("get_note_editor", {
    id: synced.value.id,
    expectedScope: synced.scope,
  });
  assert.equal(uploaded.reminders.length, 1);
  assert.equal(uploaded.reminders[0].value.entityId, synced.value.id);
  assert.equal(uploaded.reminders[0].value.repeat, "weekdays");
  checks.push(
    "Explicit first connection uploads the local card and its remapped reminder once; the real fake allocates Tack's Build-label bui reference",
  );
  let current = synced;
  for (const choice of ["keepLocal", "useRemote"]) {
    await page.getByRole("button", { name: "Local to upload", exact: true }).click();
    await editor()
      .getByLabel("Note body", { exact: true })
      .fill(
        choice === "keepLocal"
          ? "PC PC PC local winning text"
          : "LOCAL different text for losing history",
      );
    const remoteText =
      choice === "keepLocal"
        ? "REMOTE REMOTE REMOTE other device"
        : "TACK version chosen from the second device";
    await call("test.remote_edit", { id: current.value.id, patch: { body: remoteText } });
    await editor().getByRole("button", { name: "Save note", exact: true }).click();
    await editor().waitFor({ state: "detached" });
    await wait(
      async () => (await inspect()).sync.state === "conflict",
      "durable two-device text conflict",
    );
    await page.getByRole("button", { name: "Review conflicts", exact: true }).click();
    const sheet = page.getByRole("dialog", {
      name: "This note changed in two places",
      exact: true,
    });
    await sheet.getByText(remoteText, { exact: true }).waitFor();
    await sheet
      .getByRole("button", {
        name: choice === "keepLocal" ? "Keep this PC’s" : "Use Tack version",
        exact: true,
      })
      .click();
    await sheet.getByText("No unresolved conflicts in this workspace.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await call("tack_sync_now");
    await wait(async () => {
      const s = await inspect();
      return s.sync.pending === 0 && s.sync.conflicts === 0;
    }, "resolved conflict acknowledgement");
    observed = await inspect();
    current = observed.notes[0];
    assert.equal(
      current.value.body,
      choice === "keepLocal" ? "PC PC PC local winning text" : remoteText,
    );
    const data = await call("get_note_editor", {
      id: current.value.id,
      expectedScope: current.scope,
    });
    assert(
      data.revisions.some(
        (r) =>
          r.value?.body ===
          (choice === "keepLocal" ? remoteText : "LOCAL different text for losing history"),
      ),
    );
  }
  checks.push(
    "Two actual HTTP clients create text conflicts; both UI resolutions use frozen guards, survive acknowledgement and retain the losing body in note_revisions",
  );
  await page.getByRole("button", { name: "Local to upload", exact: true }).click();
  await editor().getByRole("button", { name: "History", exact: true }).click();
  await editor().getByText("LOCAL different text for losing history", { exact: true }).waitFor();
  await editor().getByRole("button", { name: "Edit reminders", exact: true }).click();
  await editor().getByLabel("Reminder 1 repeat", { exact: true }).selectOption("monthly");
  await editor().getByRole("button", { name: "Save note", exact: true }).click();
  await editor().waitFor({ state: "detached" });
  await wait(async () => (await inspect()).sync.pending === 0, "reminder acknowledgement");
  const beforeReloadTelemetry = await page.evaluate(() => ({
    events: globalThis.__NABBIT_TACK_TEST__.events,
    streamError: globalThis.__NABBIT_TACK_TEST__.streamError,
  }));
  assert(beforeReloadTelemetry.events > 0);
  assert(!beforeReloadTelemetry.streamError);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Local to upload", exact: true }).click();
  await editor().getByRole("button", { name: "Edit reminders", exact: true }).click();
  assert.equal(
    await editor().getByLabel("Reminder 1 repeat", { exact: true }).inputValue(),
    "monthly",
  );
  await page.keyboard.press("Escape");
  await editor().waitFor({ state: "detached" });
  const database = await readFile(resolve(trial, "profile/nabbit.sqlite3"));
  assert(!database.includes(Buffer.from("fixture-passphrase-42")));
  assert(!database.includes(Buffer.from(recoveryCode)));
  assert(!logs.includes(recoveryCode));
  assert(!logs.includes("fixture-passphrase-42"));
  checks.push(
    "History is readable in the editor; reminder edits round trip through the fake and reload; DB/logs contain neither synthetic password nor recovery code",
  );

  // V4.6 capture uses the exact parser result and one atomic Rust transaction.
  const capture = page.getByRole("textbox", { name: "Note title", exact: true });
  await capture.fill("Capture beta tomorrow 9am #nabbit !now");
  await page.getByLabel("Capture preview").getByText("Task", { exact: true }).waitFor();
  const countBefore = (await inspect()).notes.length;
  await capture.press("Enter");
  await wait(async () => (await capture.inputValue()) === "", "capture acknowledgement");
  const firstRequest = await page.evaluate(() =>
    globalThis.__NABBIT_TACK_TEST__.captureRequests.at(-1),
  );
  assert.equal(firstRequest.draft.title, "Capture beta");
  assert.equal(firstRequest.draft.priority, "now");
  assert.deepEqual(firstRequest.draft.labels, ["nabbit"]);
  let captured = await call("get_note_editor", {
    id: firstRequest.requestId,
    expectedScope: firstRequest.expectedScope,
  });
  assert.equal(captured.note.value.kind, "task");
  assert.equal(captured.reminders.length, 1);
  assert.equal(captured.reminders[0].value.entityId, firstRequest.requestId);
  assert.equal(captured.reminders[0].value.at, firstRequest.reminders[0].value.at);
  const replay = await page.evaluate(
    (request) => globalThis.__TAURI_INTERNALS__.invoke("capture_note", { request }),
    firstRequest,
  );
  assert.equal(replay.value.id, firstRequest.requestId);
  assert.equal((await inspect()).notes.length, countBefore + 1);
  await wait(async () => (await inspect()).sync.pending === 0, "capture sync acknowledgement");
  captured = await call("get_note_editor", {
    id: firstRequest.requestId,
    expectedScope: firstRequest.expectedScope,
  });
  assert.match(captured.note.value.ref, /^nab-[1-9][0-9]*$/);
  assert.equal(captured.reminders[0].value.entityId, captured.note.value.id);
  checks.push(
    "Parsed Enter capture writes one card/reminder atomically, replays without duplication and receives its reference through the real fake sync",
  );
  await capture.fill("Checklist draft #home !next");
  await capture.press("Shift+Enter");
  await editor().waitFor();
  assert.equal((await inspect()).notes.length, countBefore + 1, "Editor handoff is unsaved");
  await editor().getByLabel("Checklist item 1", { exact: true }).fill("Preserve stable item");
  await editor().getByLabel("Note body", { exact: true }).fill("Full editor creation body");
  await editor().getByRole("button", { name: "Purple colour", exact: true }).click();
  await editor().getByRole("button", { name: "Save note", exact: true }).click();
  await editor().waitFor({ state: "detached" });
  const secondRequest = await page.evaluate(() =>
    globalThis.__NABBIT_TACK_TEST__.captureRequests.at(-1),
  );
  const created = await call("get_note_editor", {
    id: secondRequest.requestId,
    expectedScope: secondRequest.expectedScope,
  });
  assert.equal(created.note.value.kind, "checklist");
  assert.equal(created.note.value.color, "purple");
  assert.equal(created.note.value.body, "Full editor creation body");
  assert.equal(created.note.value.items[0].text, "Preserve stable item");
  assert.equal(created.note.value.items[0].id, secondRequest.patch.items[0].id);
  checks.push(
    "Shift+Enter opens an unsaved checklist; full editor creates it once with stable item identity, parsed labels/priority, colour and body",
  );
  await verifyNotesAcceptance({
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
  });
  // Exercise durable lazy-start navigation using production SQLite, with no HWND claims.
  // Detach the live SSE consumer first: an already mounted main window can
  // legitimately consume notes:open before reload, which is a different case.
  await page.route(`${origin}/__acceptance_detached`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Detached consumer</title>",
    }),
  );
  await page.goto(`${origin}/__acceptance_detached`);
  await call("notes_open", { intent: { kind: "capture" } });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    globalThis.document.activeElement?.hasAttribute("data-note-capture"),
  );
  assert.equal((await call("take_notes_intent")).navigation, null);
  const stateBeforeLocal = await inspect();
  await call("tack_local_mode");
  await page.reload({ waitUntil: "domcontentloaded" });
  await capture.fill("Local capture #offline");
  await capture.press("Enter");
  await wait(async () => (await capture.inputValue()) === "", "local capture acknowledgement");
  const localRequest = await page.evaluate(() =>
    globalThis.__NABBIT_TACK_TEST__.captureRequests.at(-1),
  );
  const localCaptured = await call("get_note_editor", {
    id: localRequest.requestId,
    expectedScope: null,
  });
  assert.equal(localCaptured.note.localOnly, true);
  assert.equal((await inspect()).syncCalls, stateBeforeLocal.syncCalls);
  checks.push(
    "Durable capture navigation is consumed once after reload; local-only Enter capture persists with zero additional fake HTTP calls",
  );

  const telemetry = await page.evaluate(() => ({
    commands: globalThis.__NABBIT_TACK_TEST__.commands,
    events: globalThis.__NABBIT_TACK_TEST__.events,
    streamError: globalThis.__NABBIT_TACK_TEST__.streamError,
    unsupported: globalThis.__NABBIT_CAPTURE__.snapshot().unsupported,
  }));
  assert(telemetry.events + beforeReloadTelemetry.events > 0);
  assert(!telemetry.streamError);
  assert.deepEqual(telemetry.unsupported, []);
  assert.deepEqual(problems, []);
  checks.push(
    "Live Rust push events reach the browser without a polling timer; no unknown IPC or external network",
  );
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  if (page)
    failure.telemetry = await page
      .evaluate(() => ({
        headings: [...globalThis.document.querySelectorAll("h1,h2")].map(
          (node) => node.textContent,
        ),
        notes: globalThis.document.querySelectorAll(".notes-card-wrap").length,
        footer: globalThis.document.querySelector(".notes-footer")?.textContent,
        events: globalThis.__NABBIT_TACK_TEST__?.events,
        streamError: globalThis.__NABBIT_TACK_TEST__?.streamError,
        commands: globalThis.__NABBIT_TACK_TEST__?.commands,
      }))
      .catch(() => null);
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  if (info && child?.exitCode === null) await call("test.stop").catch(() => {});
  if (child) {
    await Promise.race([
      new Promise((done) => {
        if (child.exitCode !== null) done();
        else child.once("exit", done);
      }),
      setTimeout(10000),
    ]);
    if (child.exitCode === null) child.kill();
  }
  await server?.close();
  await writeFile(resolve(folder, `${prefix}-rust-log.txt`), logs, { flag: "wx" });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        passed,
        failure,
        checks,
        problems,
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        rustBridgeExitCode: child?.exitCode,
        scope:
          "Actual browser UI, typed frontend API, test-only IPC forwarding bridge, production Rust Service/client/SQLite and in-process Rust fake. HTTPS .invalid alias maps to the owned loopback fake only in the test bridge. No native Tauri IPC or OS clipboard claim.",
        noHostedTack: true,
        noUserAccount: true,
        noRealClipboard: true,
        noExternalNetwork: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
globalThis.console.log(
  `Verified ${checks.length} browser-to-Rust Notes editor/conflict/reminder cases against the actual in-process fake.`,
);
