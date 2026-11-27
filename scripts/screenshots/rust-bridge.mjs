// Test-only forwarding adapter. Never imported by a production entry.
export function installBridge(info) {
  const original = globalThis.__TAURI_INTERNALS__.invoke;
  const commands = [],
    captureRequests = [];
  const send = async (command, args = {}) => {
    commands.push(command);
    if (["capture_note", "save_link"].includes(command))
      captureRequests.push(globalThis.structuredClone(args.request));
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
    command.startsWith("bookmarks_") ||
    command.startsWith("links_") ||
    command.startsWith("link_") ||
    command === "save_link" ||
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
