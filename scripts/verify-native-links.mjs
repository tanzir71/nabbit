// Invoked inside the owned WebView2 smoke. The metadata server belongs to this
// test; production Tauri IPC/SQLite/HTTP execute unchanged, with no native picker.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
export async function verifyNativeLinks(page) {
  let requests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.authorization, undefined);
    requests++;
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<title>Fallback title</title><meta property='og:title' content='Native link metadata &amp; title'>",
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/original?utm_source=keep#section`;
    const request = {
      requestId: randomUUID(),
      expectedScope: null,
      draft: { kind: "bookmark", title: url, url },
      patch: { title: url },
      reminders: [],
    };
    const invoke = (command, args) =>
      page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), {
        command,
        args,
      });
    const note = await invoke("save_link", { request });
    assert.equal(note.value.title, "Native link metadata & title");
    assert.equal(note.value.url, url);
    assert(note.localOnly);
    const retry = await invoke("save_link", { request });
    assert.equal(retry.value.id, note.value.id);
    assert.equal(requests, 1);
    const duplicate = await invoke("save_link", {
      request: {
        ...request,
        requestId: randomUUID(),
        draft: { ...request.draft, url: url.replace("utm_source=keep#section", "fbclid=other") },
      },
    });
    assert.equal(duplicate.value.id, note.value.id);
    const read = await invoke("get_note_editor", { id: note.value.id, expectedScope: null });
    assert.deepEqual(read.note.value, note.value);
    const clean = await invoke("link_clean", { url });
    assert.equal(clean, url.replace("?utm_source=keep", ""));
    return [
      "Real Tauri save_link performs a cookie-free owned HTTP metadata GET, persists OG title and original URL to local SQLite, replays without another GET and deduplicates normalized addresses",
      "Real Tauri link_clean removes tracking from a copy while retaining the original saved URL and fragment",
    ];
  } finally {
    await new Promise((r) => server.close(r));
  }
}
