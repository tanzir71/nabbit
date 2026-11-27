// Browser -> IPC forwarding seam -> actual Rust Service/SQLite -> Rust fake.
// All services are ephemeral loopback; production HTTPS validation is retained.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
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

function installBridge(info) {
  const original = globalThis.__TAURI_INTERNALS__.invoke;
  const commands = [];
  const send = async (command, args = {}) => {
    commands.push(command);
    const response = await globalThis.fetch(`${info.url}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nabbit-Test": info.token },
      body: JSON.stringify({ command, args }),
    });
    const result = await response.json();
    if (!result.ok) throw result.error;
    return result.value;
  };
  globalThis.__TAURI_INTERNALS__.invoke = (command, args) =>
    command.startsWith("tack_") ||
    ["get_notes_state", "list_note_cards", "create_note_card", "update_note_card"].includes(command)
      ? send(command, args)
      : original(command, args);
  globalThis.__NABBIT_TACK_TEST__ = { commands, events: 0, streamError: false };
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
  prefix = process.argv[2] ?? "v44-flow";
assert(/^[a-z0-9-]+$/.test(prefix));
const folder = resolve(root, "progress/v2/M8"),
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
  await page.getByRole("button", { name: "Local to upload", exact: true }).waitFor();
  await page.getByRole("button", { name: "Connect Tack", exact: true }).click();
  await page.getByRole("dialog", { name: "Connect your Tack" }).waitFor();
  assert.equal((await inspect()).syncCalls, 0);
  await page.getByLabel("Tack address", { exact: true }).fill("http://fixture.invalid/tack/");
  await page.getByRole("button", { name: "Check server", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "HTTPS" }).waitFor();
  assert.deepEqual((await inspect()).actions, []);
  await page.getByLabel("Tack address", { exact: true }).fill(info.alias);
  await page.getByRole("button", { name: "Check server", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("Fixture");
  await page.getByLabel("Password", { exact: true }).fill("fixture-passphrase-42");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Save your recovery code", exact: true }).waitFor();
  const code = await page.getByLabel("Recovery code", { exact: true }).textContent();
  assert(code && code.length > 10);
  assert(
    await page.getByRole("button", { name: "I saved it — continue", exact: true }).isDisabled(),
  );
  assert.equal((await inspect()).syncCalls, 0);
  await page.getByRole("button", { name: "Copy recovery code", exact: true }).click();
  await page.getByText("Recovery code copied.", { exact: true }).waitFor();
  assert.equal((await inspect()).copyCount, 1);
  await page.getByLabel("I saved my recovery code", { exact: true }).check();
  await call("test.fault", { status: 409 });
  await page.getByRole("button", { name: "I saved it — continue", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "changed or expired" }).waitFor();
  assert.equal(await page.getByLabel("Recovery code", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
  await page.getByLabel("Password", { exact: true }).fill("fixture-passphrase-42");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Save your recovery code", exact: true }).waitFor();
  const currentCode = await page.getByLabel("Recovery code", { exact: true }).textContent();
  assert(currentCode && currentCode !== code, "A new login rotates an unconfirmed recovery code");
  assert(
    await page.getByRole("button", { name: "I saved it — continue", exact: true }).isDisabled(),
  );
  await page.getByLabel("I saved my recovery code", { exact: true }).check();
  await page.getByRole("button", { name: "I saved it — continue", exact: true }).click();
  await page.getByRole("heading", { name: "Choose what to sync", exact: true }).waitFor();
  assert.equal((await inspect()).syncCalls, 0);
  assert.equal(await page.getByLabel("Recovery code", { exact: true }).count(), 0);
  checks.push(
    "HTTPS validation, sign in, password input clearing, recovery copy seam, stale-code reset and mandatory confirmation of the rotated code; no sync before workspace confirmation",
  );
  await page.getByRole("radio", { name: /Team/ }).check();
  await wait(
    async () => await page.getByRole("button", { name: "Start syncing", exact: true }).isEnabled(),
    "selected scope loaded",
  );
  await page.getByRole("switch", { name: "Show Tack tasks too", exact: true }).click();
  await page.getByRole("switch", { name: "Only cards with a label", exact: true }).click();
  await page.getByLabel("Labels to show", { exact: true }).fill("Build, Ideas");
  const upload = page.getByRole("checkbox", { name: /Upload 1 local note/ });
  assert(!(await upload.isChecked()));
  await upload.check();
  await page.getByRole("button", { name: "Start syncing", exact: true }).click();
  await wait(async () => {
    const state = await inspect();
    return state.enabled && state.sync.state === "upToDate" && state.sync.pending === 0;
  }, "actual fake acknowledgement");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "No matching notes", exact: true }).waitFor();
  let state = await inspect();
  assert.equal(state.notes.length, 1);
  assert.equal(state.profile.localCount, 0);
  assert.equal(state.profile.preferences.showTasks, false);
  assert.deepEqual(state.profile.preferences.labels, ["Build", "Ideas"]);
  assert(state.notes[0].value.ref.startsWith("tck-"));
  await page.getByRole("button", { name: "Tack settings", exact: true }).click();
  await page.getByLabel("Labels to show", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Labels to show", { exact: true }).inputValue(),
    "Build, Ideas",
  );
  assert.equal(await page.getByRole("checkbox", { name: /Upload .*local/ }).count(), 0);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.waitForFunction(
    () => globalThis.document.activeElement?.textContent === "Tack settings",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Tack settings", exact: true }).waitFor();
  state = await inspect();
  assert.equal(state.notes.length, 1);
  assert.equal(state.profile.localCount, 0);
  const database = await readFile(resolve(trial, "profile/nabbit.sqlite3"));
  assert(!database.includes(Buffer.from("fixture-passphrase-42")));
  assert(!database.includes(Buffer.from(code)));
  assert(!database.includes(Buffer.from(currentCode)));
  assert(!logs.includes(code));
  assert(!logs.includes(currentCode));
  assert(!logs.includes("fixture-passphrase-42"));
  checks.push(
    "Explicit Team selection, persisted task/label scope, unchecked one-time local upload, real server ref, no duplicate after reopening/reload, no password or recovery code in DB/logs",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByText("Keep notes on this PC or connect your Tack", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Connect Tack", exact: true }).last().click();
  await page.getByLabel("Username", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Username", { exact: true }).inputValue(), "fixture");
  assert.equal(await page.getByLabel("Tack address", { exact: true }).inputValue(), info.alias);
  assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
  await call("test.fault", { status: 503 });
  await page.getByLabel("Password", { exact: true }).fill("fixture-passphrase-42");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "could not be reached" }).waitFor();
  assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
  assert(!(await page.locator("body").innerText()).includes("untrusted fixture response detail"));
  await call("test.fault", { status: 429 });
  await page.getByLabel("Password", { exact: true }).fill("fixture-passphrase-42");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "limited attempts" }).waitFor();
  assert(await page.getByRole("button", { name: "Sign in", exact: true }).isDisabled());
  await wait(
    async () => await page.getByRole("button", { name: "Sign in", exact: true }).isEnabled(),
    "Retry-After expiration",
  );
  const beforeLocalOnly = (await inspect()).actions.length;
  await page.getByRole("button", { name: "Use local notes only", exact: true }).last().click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  state = await inspect();
  assert.equal(state.notes.length, 0);
  assert(!state.enabled);
  assert.equal(state.sync.scope, null);
  assert.equal(state.actions.length, beforeLocalOnly);
  const storedCards = Number(
    execFileSync(
      "python",
      [
        "-c",
        "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print(c.execute('SELECT count(*) FROM note_cards').fetchone()[0]); c.close()",
        resolve(trial, "profile/nabbit.sqlite3"),
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim(),
  );
  assert.equal(storedCards, 1);
  checks.push(
    "Settings signout retains notes; reconnect prefills non-secret hints, clears password, sanitizes 503 and honors 429 retry delay",
  );
  checks.push(
    "Escape restores the opener focus; choosing local-only makes no HTTP request and retains the cached Tack card in SQLite",
  );
  const telemetry = await page.evaluate(() => ({
    commands: globalThis.__NABBIT_TACK_TEST__.commands,
    events: globalThis.__NABBIT_TACK_TEST__.events,
    streamError: globalThis.__NABBIT_TACK_TEST__.streamError,
    unsupported: globalThis.__NABBIT_CAPTURE__.snapshot().unsupported,
  }));
  assert(telemetry.events > 0);
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
  `Verified ${checks.length} browser-to-Rust Tack connection cases against the actual in-process fake.`,
);
