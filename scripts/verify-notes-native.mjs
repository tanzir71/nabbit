import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { fixtureData } from "./screenshots/fixtures.mjs";
import { pngInfo } from "./screenshots/policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = resolve(root, process.argv[2] ?? "src-tauri/target/release/nabbit.exe");
const prefix = process.argv[3] ?? "v41-native";
assert(/^[a-z0-9-]+$/.test(prefix));
const folder = resolve(root, "progress/v2/M8"),
  trial = resolve(root, `.tools/${prefix}-${randomUUID()}`),
  profile = resolve(trial, "app-data"),
  control = resolve(trial, "control"),
  database = resolve(profile, "nabbit.sqlite3");
await mkdir(folder, { recursive: true });
await mkdir(profile, { recursive: true });
await mkdir(control, { recursive: true });
const reportFile = resolve(folder, `${prefix}-native.json`);
await stat(reportFile).then(
  () => {
    throw new Error("Evidence prefix already exists");
  },
  (e) => assert.equal(e.code, "ENOENT"),
);
assert.equal(
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "@(Get-Process -Name nabbit -ErrorAction SilentlyContinue).Count"],
    { encoding: "utf8", windowsHide: true },
  ).trim(),
  "0",
  "An existing Nabbit process is left untouched",
);
const settings = {
  ...fixtureData("tray-downloads").settings,
  theme: "light",
  lastTab: "notes",
  firstRunAcknowledged: true,
  engineAutoUpdate: false,
  outputDir: resolve(trial, "downloads"),
  startHidden: false,
  launchAtLogin: false,
};
const settingsFile = resolve(trial, "settings.json");
await writeFile(settingsFile, JSON.stringify(settings));
execFileSync(
  "python",
  [
    "-c",
    "import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)'); db.execute('INSERT INTO settings VALUES(?,?,?)',('app_settings',open(sys.argv[2],encoding='utf-8').read(),'2026-11-27T04:00:00.000Z')); db.commit(); db.close()",
    database,
    settingsFile,
  ],
  { windowsHide: true },
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const readDb = () =>
  JSON.parse(
    execFileSync(
      "python",
      [
        "-c",
        "import sqlite3,json,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(json.dumps({'notes':[{'value':json.loads(r[0]),'localOnly':bool(r[1]),'updatedAtColumn':r[2]} for r in c.execute('SELECT value,local_only,updated_at FROM note_cards ORDER BY id')], 'downloads':c.execute('SELECT COUNT(*) FROM downloads').fetchone()[0], 'clipboard':c.execute('SELECT COUNT(*) FROM clipboard_entries').fetchone()[0], 'tables':[r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\")]})); c.close()",
        database,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
let app,
  browser,
  page,
  log = "",
  passed = false,
  failure;
const checks = [],
  captures = [],
  networkProblems = [],
  rendererProblems = [];
const wait = async (fn, label, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    if (app && app.exitCode !== null) throw new Error(`Owned app exited: ${log}`);
    await setTimeout(100);
  }
  throw new Error(`Timed out: ${label}`);
};
async function start(expectedTheme = "light") {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  const env = {
    ...process.env,
    NABBIT_APP_DATA_DIR: profile,
    NABBIT_ACCEPTANCE_COMMAND_DIR: control,
    NABBIT_ACCEPTANCE_FAKE_DOWNLOAD: "1",
    NABBIT_DOWNLOAD_ACCEPTANCE: "1",
    NABBIT_ACCEPTANCE_CLIPBOARD_PROVIDER: "1",
    WEBVIEW2_USER_DATA_FOLDER: resolve(trial, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  };
  for (const key of [
    "NABBIT_ISLAND_SPIKE",
    "NABBIT_ISLAND_ACCEPTANCE",
    "NABBIT_ACCEPTANCE_DOWNLOAD_FIXTURE",
  ])
    delete env[key];
  app = spawn(executable, [], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [app.stdout, app.stderr])
    stream.on("data", (b) => {
      log += b.toString();
    });
  await wait(async () => {
    try {
      return (await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, "owned WebView2 endpoint");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await wait(async () => {
    for (const target of browser.contexts().flatMap((c) => c.pages()))
      if (
        (await target
          .evaluate(() => globalThis.__TAURI_INTERNALS__?.metadata?.currentWindow?.label)
          .catch(() => null)) === "main"
      )
        return target;
    return false;
  }, "owned main page");
  page.on("pageerror", (e) => rendererProblems.push(e.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !["tauri.localhost", "ipc.localhost", "127.0.0.1"].includes(url.hostname)
    ) {
      networkProblems.push(url.origin);
      return route.abort();
    }
    return route.continue();
  });
  await page.getByText("Local only · Saved on this device", { exact: true }).waitFor();
  await page.waitForFunction(
    (theme) => globalThis.document.documentElement.dataset.theme === theme,
    expectedTheme,
  );
}
async function stop() {
  if (app?.exitCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "pipe",
      });
    } catch (error) {
      log += `\nOwned process cleanup: ${error.message}`;
    }
    const end = Date.now() + 10000;
    while (app.exitCode === null && Date.now() < end) await setTimeout(50);
    assert.notEqual(app.exitCode, null);
  }
  if (browser) await browser.close().catch(() => {});
  browser = null;
  page = null;
}
const invoke = (command, args) =>
  page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function snap(name) {
  const state = readDb();
  checks.push({ name, state });
  return state;
}
async function capture(name) {
  await page.evaluate(() => globalThis.document.activeElement?.blur());
  await page.evaluate(() => globalThis.document.fonts.ready);
  const dimensions = await page.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    dpr: globalThis.devicePixelRatio,
  }));
  const options = { type: "png", scale: "device", animations: "disabled", caret: "initial" };
  const bytes = await page.screenshot(options),
    repeat = await page.screenshot(options);
  assert.equal(hash(bytes), hash(repeat), "Native capture must repeat exactly");
  assert(bytes.length <= 300000);
  const metadata = pngInfo(
    bytes,
    Math.round(dimensions.width * dimensions.dpr),
    Math.round(dimensions.height * dimensions.dpr),
  );
  const file = `${prefix}-${name}.png`;
  await writeFile(resolve(folder, file), bytes, { flag: "wx" });
  captures.push({
    file,
    ...dimensions,
    ...metadata,
    bytes: bytes.length,
    sha256: hash(bytes),
    repeatIdentical: true,
  });
}
try {
  await start();
  await page.getByRole("heading", { name: "A place for your notes", exact: true }).waitFor();
  assert.equal((await invoke("list_note_cards")).length, 0);
  await snap("empty local-only store");
  await page.getByLabel("Note title", { exact: true }).fill("Local-only acceptance note");
  await page.getByLabel("Note title", { exact: true }).focus();
  await page
    .getByLabel("Note body", { exact: true })
    .fill("Written without a Tack server or account.");
  await page.getByLabel("Note priority", { exact: true }).selectOption("now");
  await page.getByLabel("Note colour", { exact: true }).selectOption("blue");
  await page.getByLabel("Note labels", { exact: true }).fill("Work, Ideas");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("button", { name: "Local-only acceptance note", exact: true }).waitFor();
  const first = (await invoke("list_note_cards"))[0];
  assert(first.localOnly);
  assert.equal(first.value.ref, "");
  assert.equal(first.value.revision, 0);
  assert.match(
    first.value.id,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  await snap("native capture persisted with complete card shape");
  await page.getByLabel("Note title", { exact: true }).fill("Stable checklist");
  await page.getByRole("button", { name: "New checklist", exact: true }).click();
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await page
      .getByLabel(`Checklist item ${i + 1}`, { exact: true })
      .fill(["First row", "Keep this checked row", "Third row"][i]);
  }
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  // The controlled checkbox reflects its durable SQLite reply. Click, then
  // independently await the native DOM and the stored checked state.
  await page.getByRole("checkbox", { name: "Keep this checked row", exact: true }).click();
  await wait(async () => {
    const row = (await invoke("list_note_cards")).find((n) => n.value.title === "Stable checklist");
    return row?.value.items[1].checked && row;
  }, "checked row persisted");
  await wait(
    () => page.getByRole("checkbox", { name: "Keep this checked row", exact: true }).isChecked(),
    "native checkbox reflects durable state",
  );
  const list = (await invoke("list_note_cards")).find((n) => n.value.title === "Stable checklist"),
    keptId = list.value.items[1].id;
  await page.getByRole("button", { name: "Stable checklist", exact: true }).click();
  await page.getByRole("button", { name: "Remove item 1", exact: true }).click();
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await wait(async () => {
    const row = (await invoke("list_note_cards")).find((n) => n.value.id === list.value.id);
    return row.value.items.length === 2 && row;
  }, "removed only the first checklist row");
  assert.equal(
    (await invoke("list_note_cards")).find((n) => n.value.id === list.value.id).value.items[0].id,
    keptId,
  );
  await snap("native checklist updates preserve stable IDs and checked state");
  await page.getByLabel("Note title", { exact: true }).fill("Tauri documentation");
  await page.getByRole("button", { name: "New link note", exact: true }).click();
  await page
    .getByLabel("Link URL", { exact: true })
    .fill("https://v2.tauri.app/reference/javascript/api");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("button", { name: "Tauri documentation", exact: true }).waitFor();
  const count = (await invoke("list_note_cards")).length;
  const rejected = await invoke("create_note_card", {
    draft: { title: "Invalid link", kind: "bookmark", url: "javascript:alert(1)" },
  }).then(
    () => false,
    (error) => String(error),
  );
  assert.match(rejected, /http or https/);
  assert.equal((await invoke("list_note_cards")).length, count);
  await page.getByLabel("Actions for Local-only acceptance note", { exact: true }).click();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await page
    .getByRole("region", { name: "Pinned", exact: true })
    .getByRole("button", { name: "Local-only acceptance note", exact: true })
    .waitFor();
  await page.getByLabel("Actions for Tauri documentation", { exact: true }).click();
  await page
    .locator(".notes-card-menu[open]")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await wait(
    async () =>
      !(await page.getByRole("button", { name: "Tauri documentation", exact: true }).count()),
    "archived card hidden",
  );
  await page.getByLabel("Notes view and labels", { exact: true }).click();
  await page
    .locator(".notes-view-menu")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await page.getByRole("button", { name: "Tauri documentation", exact: true }).waitFor();
  await page.getByLabel("Actions for Tauri documentation", { exact: true }).click();
  await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await page.getByLabel("Notes view and labels", { exact: true }).click();
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByRole("button", { name: "Tauri documentation", exact: true }).waitFor();
  await page.getByLabel("Actions for Tauri documentation", { exact: true }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await wait(async () => {
    const n = (await invoke("list_note_cards")).find(
      (n) => n.value.title === "Tauri documentation",
    );
    return n.value.archived && !n.value.trashedAt;
  }, "trash restore preserves archive flag");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await page.getByRole("button", { name: "Local-only acceptance note", exact: true }).waitFor();
  await page.getByRole("button", { name: "Now", exact: true }).click();
  assert.equal(await page.locator(".notes-card-wrap").count(), 1);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Search notes", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search notes", exact: true }).fill("without a Tack");
  assert.equal(await page.locator(".notes-card-wrap").count(), 1);
  await page.getByRole("searchbox", { name: "Search notes", exact: true }).fill("");
  await snap("pin, priority/search filters and soft archive/trash/restore use real IPC");
  await capture("light");
  const currentSettings = await invoke("get_settings");
  await invoke("save_settings", { settings: { ...currentSettings, theme: "dark" } });
  await stop();
  // Seed newer server-shaped fields only in this stopped, owned fixture profile.
  execFileSync(
    "python",
    [
      "-c",
      "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); row=c.execute('SELECT value FROM note_cards WHERE id=?',(sys.argv[2],)).fetchone(); v=json.loads(row[0]); v['futureServerField']={'nested':[1,{'kept':True}]}; v['agentState']={'status':'open','newKey':'preserved'}; c.execute('UPDATE note_cards SET value=? WHERE id=?',(json.dumps(v),sys.argv[2])); c.commit(); c.close()",
      database,
      first.value.id,
    ],
    { windowsHide: true },
  );
  await start("dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal((await invoke("get_settings")).lastTab, "notes");
  assert.equal((await invoke("list_note_cards")).length, 3);
  await page.getByRole("button", { name: "Local-only acceptance note", exact: true }).click();
  await page.getByLabel("Note body", { exact: true }).fill("Unsaved stale draft");
  let latest = (await invoke("list_note_cards")).find((n) => n.value.id === first.value.id);
  await invoke("update_note_card", {
    id: first.value.id,
    expectedRevision: latest.value.revision,
    patch: { body: "Concurrent window value" },
  });
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "another window" }).waitFor();
  assert.equal(
    await page.getByLabel("Note body", { exact: true }).inputValue(),
    "Unsaved stale draft",
  );
  latest = (await invoke("list_note_cards")).find((n) => n.value.id === first.value.id);
  assert.equal(latest.value.body, "Concurrent window value");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Local-only acceptance note", exact: true }).click();
  await page.getByLabel("Note title", { exact: true }).fill("Persisted after restart");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("button", { name: "Persisted after restart", exact: true }).waitFor();
  latest = (await invoke("list_note_cards")).find((n) => n.value.id === first.value.id);
  assert.deepEqual(latest.value.futureServerField, { nested: [1, { kept: true }] });
  assert.deepEqual(latest.value.agentState, { status: "open", newKey: "preserved" });
  assert.equal(latest.value.body, "Concurrent window value");
  assert.equal(latest.value.ref, "");
  await snap("restart, stale revision rejection, retained draft and unknown JSON preservation");
  await page.getByLabel("Actions for Persisted after restart", { exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".notes-card-menu[open]").count(), 0);
  await capture("dark");
  assert.equal(await page.getByText("Open Tack", { exact: true }).count(), 0);
  assert.deepEqual(networkProblems, []);
  assert.deepEqual(rendererProblems, []);
  const final = readDb();
  assert.equal(final.downloads, 0);
  assert.equal(final.clipboard, 0);
  assert(!final.tables.includes("tack_outbox"));
  assert(final.notes.every((n) => n.localOnly && n.updatedAtColumn === n.value.updatedAt));
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await stop();
  await writeFile(resolve(folder, `${prefix}-native-log.txt`), log, { flag: "wx" });
  await writeFile(
    reportFile,
    JSON.stringify(
      {
        passed,
        failure,
        source: "owned unsigned release executable, real tray DOM/Tauri IPC/SQLite; no mock IPC",
        executable,
        executableSha256: hash(await readFile(executable)),
        buildManifestSha256: hash(await readFile(resolve(root, "dist/.vite/manifest.json"))),
        profile,
        checks,
        captures,
        networkProblems,
        rendererProblems,
        limits: [
          "Native capture uses the actual device scale; the browser matrix separately covers 1x/1.5x light/dark.",
          "The isolated acceptance provider disables real clipboard and OS shortcut/autostart configuration; no Tack endpoint, account or network is used.",
          "The dedicated editor, Tack connection/sync, parsed island quick capture, sticky windows and bookmark imports remain later tasks.",
          "Existing V0/V2.7 native performance/frame/focus limitations are unchanged.",
        ],
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
globalThis.console.log(
  `Verified ${checks.length} native Notes cases, real SQLite restart and ${captures.length} repeat-identical owned WebView2 captures.`,
);
