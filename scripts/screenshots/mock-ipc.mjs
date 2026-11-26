// Self-contained for Playwright addInitScript. This file is never imported by
// an application entry. It exercises the real frontend Tauri API callsites.
export function installMockIpc(seed) {
  const state = globalThis.structuredClone(seed.data);
  const calls = [],
    unsupported = [],
    callbacks = new Map(),
    listeners = new Map();
  let nextId = 1;
  const clone = (value) => (value === undefined ? undefined : globalThis.structuredClone(value));
  const dispatch = (event, payload) => {
    for (const [id, entry] of [...listeners]) {
      if (entry.event === event) runCallback(entry.handler, { event, id, payload: clone(payload) });
    }
  };
  const unregister = (_event, id) => {
    const entry = listeners.get(id);
    if (entry) callbacks.delete(entry.handler);
    listeners.delete(id);
  };
  const runCallback = (id, value) => {
    const entry = callbacks.get(id);
    if (entry?.once) callbacks.delete(id);
    entry?.handler(value);
  };
  const invoke = async (command, args = {}) => {
    calls.push({ command, args: clone(args) });
    if (seed.failures?.[command]) throw new Error(seed.failures[command]);
    switch (command) {
      case "get_settings":
        return clone(state.settings);
      case "island_set_hitrect":
      case "island_clear_hitrect":
      case "island_set_drag":
        return null;
      case "get_island_snapshot":
        return clone(
          seed.responses?.get_island_snapshot ?? {
            supported: true,
            visibility: [
              {
                label: seed.label,
                mode: "visible",
                base: "visible",
                reason: "none",
                opacity: 1,
                revision: 0,
              },
            ],
            desktop: {
              monitors: [{ id: "primary", name: "Fixture display", primary: true, scaleFactor: 1 }],
            },
            lastError: null,
          },
        );
      case "save_island_preferences":
        state.settings.island = clone(args.preferences);
        return clone(state.settings);
      case "save_settings":
        state.settings = clone(args.settings);
        return clone(state.settings);
      case "acknowledge_first_run":
        state.settings.firstRunAcknowledged = true;
        return clone(state.settings);
      case "list_clipboard_entries":
        return clone(state.clipboard);
      case "list_downloads":
        return clone(state.jobs);
      case "get_engine_status":
        return clone(state.engine);
      case "get_staged_url":
        return state.stagedUrl;
      case "get_storage_stats":
        return {
          clipboardCount: state.clipboard.length,
          downloadCount: state.jobs.length,
          dbSizeBytes: 24576,
        };
      case "copy_clipboard_entry":
        return undefined; // No OS clipboard access.
      case "plugin:window|theme":
        return seed.theme;
      case "plugin:window|hide":
        state.hidden = true;
        return undefined;
      case "plugin:window|is_visible":
        return !state.hidden;
      case "plugin:event|listen": {
        const id = nextId++;
        listeners.set(id, { event: args.event, handler: args.handler });
        return id;
      }
      case "plugin:event|unlisten":
        unregister(args.event, args.eventId);
        return undefined;
      case "plugin:event|emit":
        dispatch(args.event, args.payload);
        return undefined;
      default: {
        if (Object.hasOwn(seed.responses ?? {}, command)) return clone(seed.responses[command]);
        unsupported.push(command);
        throw new Error(`Screenshot fixture has no IPC response: ${command}`);
      }
    }
  };
  globalThis.isTauri = true;
  globalThis.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: seed.label },
      currentWebview: { label: seed.label, windowLabel: seed.label },
    },
    invoke,
    transformCallback(handler, once = false) {
      const id = nextId++;
      callbacks.set(id, { handler, once });
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback,
  };
  globalThis.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: unregister };
  globalThis.__NABBIT_CAPTURE__ = {
    emit: dispatch,
    patch: (value) => Object.assign(state, clone(value)),
    snapshot: () => ({
      calls: clone(calls),
      unsupported: [...unsupported],
      state: clone(state),
      listenerCount: listeners.size,
    }),
  };
  globalThis.localStorage.setItem("nabbit.theme.v1", state.settings.theme);
}
