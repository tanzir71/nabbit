// Self-contained for Playwright addInitScript. This file is never imported by
// an application entry. It exercises the real frontend Tauri API callsites.
export function installMockIpc(seed) {
  const state = globalThis.structuredClone(seed.data);
  const calls = [],
    unsupported = [],
    callbacks = new Map(),
    listeners = new Map();
  let nextId = 1;
  let surfaceGeneration = seed.responses?.get_island_surface?.generation ?? 0;
  let surfaceState = seed.responses?.get_island_surface?.state ?? "idle";
  let keyboardId = seed.responses?.get_island_surface?.keyboard?.id ?? 0;
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
    const loggedArgs = clone(args);
    if (["tack_login", "tack_confirm_recovery", "tack_copy_recovery"].includes(command)) {
      for (const key of ["password", "code"])
        if (Object.hasOwn(loggedArgs, key)) loggedArgs[key] = "[redacted]";
    }
    calls.push({ command, args: loggedArgs });
    if (seed.failures?.[command]) {
      const failure = seed.failures[command];
      throw typeof failure === "string" ? new Error(failure) : clone(failure);
    }
    switch (command) {
      case "files_pins":
        return clone(state.filePins ?? seed.responses?.files_pins ?? []);
      case "files_capabilities":
        return clone(
          seed.responses?.files_capabilities ?? { folders: [], terminal: false, code: false },
        );
      case "files_history":
      case "files_suggestions":
        return clone(seed.responses?.[command] ?? []);
      case "files_hints":
        return clone(seed.responses?.files_hints ?? {});
      case "files_peek_open":
        return clone(
          seed.responses?.files_peek_open ?? {
            token: "fixture-peek",
            path: "D:\\Fixture",
            items: [],
            watching: true,
          },
        );
      case "files_peek_items":
        return clone(seed.responses?.files_peek_open?.items ?? []);
      case "files_peek_close":
      case "files_pin_action":
        return null;
      case "files_choose":
        return clone(seed.responses?.files_choose ?? null);
      case "files_drop_status":
        return 1;
      case "files_download_info":
        return clone(
          seed.responses?.files_download_info ?? {
            path: "C:\\Fixture\\file.mkv",
            bytes: 1400000000,
            site: "example.invalid",
          },
        );
      case "files_remove_pin":
        state.filePins = clone(state.filePins ?? seed.responses?.files_pins ?? []).filter(
          (pin) => pin.id !== args.id,
        );
        dispatch("pins:changed", null);
        return null;
      case "files_plan":
        return clone(
          seed.responses?.files_plan ?? {
            id: "fixture-operation",
            destination: { path: args.request.destination ?? "D:\\Fixture\\Invoices" },
            entries: args.request.paths.map((path) => ({
              source: { path },
              verb: args.request.modifiers.ctrl ? "copy" : "move",
              output: null,
              undone: false,
            })),
            reasons: [],
            bytes: 1200,
            status: "prepared",
            error: null,
          },
        );
      case "files_execute":
        return clone(
          seed.responses?.files_execute ?? {
            id: args.id,
            destination: { path: "D:\\Fixture\\Invoices" },
            entries: [
              {
                source: { path: "D:\\Fixture\\file.pdf" },
                verb: "move",
                output: "D:\\Fixture\\Invoices\\file.pdf",
                fingerprint: {},
                undone: false,
              },
            ],
            reasons: [],
            bytes: 1200,
            status: "completed",
            error: null,
          },
        );
      case "files_undo":
        dispatch("files:changed", null);
        return clone(seed.responses?.files_undo ?? {});
      case "tool_suggest":
        return clone(seed.responses?.tool_suggest ?? null);
      case "tool_catalog":
      case "tool_jobs":
      case "tool_presets":
        return clone(seed.responses?.[command] ?? []);
      case "timer_view":
        return null;
      case "timer_snapshot":
        return clone(
          state.timer ?? {
            revision: 0,
            generation: 0,
            config: {
              preset: "25/5",
              focusS: 1500,
              breakS: 300,
              rounds: 4,
              label: "Focus",
              card: null,
            },
            session: null,
            linkedCard: null,
            linkUnavailable: false,
            shortcutError: null,
            error: null,
          },
        );
      case "media_snapshot":
        return clone(
          state.media ?? { revision: 0, sessions: [], selected: null, volume: null, error: null },
        );
      case "shelf_list":
        return clone(state.shelf ?? []);
      case "shelf_preview":
        return clone(seed.shelfPreview ?? null);
      case "shelf_drag_active":
        return null;
      case "shelf_copy_paths":
        return null; // Intent only, never OS clipboard.
      case "shelf_remove":
        state.shelf =
          args.ids === null
            ? []
            : (state.shelf ?? []).filter((item) => !args.ids.includes(item.id));
        dispatch("shelf:changed", null);
        return null;
      case "shelf_drag_plan": {
        const rows = (state.shelf ?? []).filter((item) => args.ids.includes(item.id));
        if (rows.length !== new Set(args.ids).size || rows.some((item) => !item.available))
          throw Error("Fixture missing file");
        return {
          item: rows.map((item) => item.path),
          icon: seed.shelfPreview ?? "data:image/png;base64,",
          mode: "copy",
        };
      }
      case "plugin:drag|start_drag":
        args.onEvent.onmessage({ result: "Cancelled", cursorPos: { x: 0, y: 0 } });
        return null; // Recording provider only, no interactive drag.
      case "save_link":
      case "capture_note": {
        const request = clone(args.request);
        const value = {
          ...request.draft,
          ...request.patch,
          id: request.requestId,
          title: request.patch?.title ?? request.draft.title,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          labels: request.patch?.labels ?? request.draft.labels ?? [],
          kind: request.patch?.kind ?? request.draft.kind ?? "note",
          archived: false,
          trashedAt: null,
          items: [],
          revision: 0,
          priority: request.draft.priority ?? "inbox",
        };
        const saved = {
          value,
          scope: request.expectedScope,
          localOnly: !request.expectedScope,
          editToken: "fixture-edit",
        };
        state.notes ??= [];
        state.notes.unshift(saved);
        dispatch("notes:updated", null);
        return clone(saved);
      }
      case "bookmarks_discover":
      case "bookmarks_pick_html":
      case "bookmarks_preview":
      case "bookmarks_commit":
        if (!Object.hasOwn(seed.responses ?? {}, command))
          throw new Error(`Missing explicit ${command} fixture`);
        return clone(seed.responses[command]);
      case "bookmarks_release":
        return null;
      case "bookmarks_history":
        return clone(seed.responses?.bookmarks_history ?? []);
      case "bookmarks_undo":
        return seed.responses?.bookmarks_undo ?? 0;
      case "links_bulk":
      case "links_open":
        return args.guards.length;
      case "link_open_url":
      case "plugin:clipboard-manager|write_text":
        return null; // Record intent only: never use OS clipboard or shell in a fixture.
      case "link_clean": {
        const url = new globalThis.URL(args.url);
        for (const key of [...url.searchParams.keys()])
          if (/^utm_/i.test(key) || ["fbclid", "gclid", "mc_eid"].includes(key.toLowerCase()))
            url.searchParams.delete(key);
        return url.href;
      }
      case "take_notes_intent":
        return clone(
          seed.responses?.take_notes_intent ?? { navigation: null, shortcutError: null },
        );
      case "notes_open":
        return null;
      case "consume_island_settings_intent":
        return false;
      case "get_island_surface":
        return clone(
          seed.responses?.get_island_surface ?? {
            label: seed.label,
            generation: surfaceGeneration,
            state: "idle",
            owner: "native",
            shape: "island",
            reducedMotion: false,
            width: 112,
            height: 26,
            snapshot: await invoke("get_activity_snapshot"),
          },
        );
      case "island_surface_request": {
        const value = clone(
          seed.responses?.get_island_surface ?? {
            label: seed.label,
            shape: "island",
            reducedMotion: false,
            width: 112,
            height: 26,
          },
        );
        value.generation = ++surfaceGeneration;
        value.state = args.state;
        surfaceState = args.state;
        value.owner = ["idle", "faded", "hidden", "live"].includes(args.state)
          ? "native"
          : "webview";
        value.snapshot = await invoke("get_activity_snapshot");
        dispatch("nabbit://island-surface", value);
        return null;
      }
      case "island_toggle_keyboard": {
        if (
          args.trigger &&
          (state.settings.islandShortcut ?? "Alt+Space").toLowerCase() !==
            args.trigger.toLowerCase()
        )
          return null;
        const snapshot = await invoke("get_activity_snapshot");
        const view = snapshot.views.find((view) => view.label === seed.label);
        if (view?.gate === "hidden" || view?.fullscreen) return null;
        const compact = view?.primary ? "live" : view?.gate === "faded" ? "faded" : "idle";
        await invoke("island_surface_request", {
          state: surfaceState === "expanded" ? compact : "expanded",
        });
        if (surfaceState === "expanded") await invoke("island_keyboard_focus", { target: "tab" });
        return null;
      }
      case "island_keyboard_focus": {
        const base = clone(await invoke("get_island_surface"));
        base.state = surfaceState;
        base.generation = surfaceGeneration;
        base.keyboard = { id: ++keyboardId, target: args.target };
        dispatch("nabbit://island-surface", base);
        return null;
      }
      case "island_keyboard_ready":
        return null;
      case "list_island_pins":
        return clone(seed.responses?.list_island_pins ?? []);
      case "island_open_pin": {
        const pins = seed.responses?.list_island_pins ?? [];
        if (!pins.some((pin) => (args.id ? pin.id === args.id : pin.slot === args.slot)))
          throw new Error("This pin slot is empty");
        return null; // Explicit intent only; never launch a real file from a fixture.
      }
      case "island_surface_ack":
        return null;
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
      case "get_activity_snapshot":
        return clone(
          state.activity ??
            seed.responses?.get_activity_snapshot ?? {
              revision: 0,
              views: [
                {
                  label: seed.label,
                  gate: "visible",
                  primary: null,
                  bubble: null,
                  queue: [],
                  fullscreen: false,
                  userHidden: false,
                  focusMode: false,
                },
              ],
              preferences: {
                order: [
                  "privacy",
                  "timerEnding",
                  "download",
                  "tool",
                  "link",
                  "result",
                  "media",
                  "timer",
                  "power",
                ],
                disabled: [],
                showAlertsOverFullscreen: false,
                focusMode: false,
                hiddenUntilMs: null,
              },
              syncState: "localOnly",
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
        return clone(
          state.clipboard.filter(
            (entry) =>
              !args.query ||
              `${entry.preview} ${entry.content}`
                .toLocaleLowerCase()
                .includes(args.query.toLocaleLowerCase()),
          ),
        );
      case "list_downloads":
        return clone(state.jobs);
      case "list_note_cards":
        return clone(state.notes ?? []);
      case "get_notes_state":
        return clone(seed.responses?.get_notes_state ?? { cards: state.notes ?? [], scope: null });
      case "tack_snapshot":
        return clone(
          seed.responses?.tack_snapshot ?? {
            checked: false,
            baseUrl: null,
            user: null,
            workspace: null,
            workspaces: [],
            recoveryPending: false,
            requiresLogin: true,
            ready: false,
            error: null,
          },
        );
      case "tack_profile":
      case "tack_workspace_profile":
        return clone(
          seed.responses?.[command] ?? {
            baseUrl: null,
            username: "",
            localCount: (state.notes ?? []).filter((note) => note.localOnly).length,
            preferences: { showTasks: true, filterLabels: false, labels: [] },
            labels: [],
            readOnly: false,
          },
        );
      case "tack_sync_snapshot":
        return clone(
          seed.responses?.tack_sync_snapshot ?? {
            state: "localOnly",
            scope: null,
            pending: 0,
            conflicts: 0,
            referenceIssues: 0,
            lastSynced: null,
            error: null,
            nextAttemptMs: null,
          },
        );
      case "create_note_card": {
        const draft = clone(args.draft),
          now = new Date().toISOString();
        const card = {
          localOnly: true,
          value: {
            id: globalThis.crypto.randomUUID(),
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
            pinned: false,
            archived: false,
            trashedAt: null,
            completed: false,
            color: "default",
            rank: "a0",
            projectId: null,
            createdAt: now,
            updatedAt: now,
            sourceId: null,
            ...draft,
          },
        };
        card.value.items = (draft.items ?? []).map((text) => ({
          id: globalThis.crypto.randomUUID(),
          text,
          checked: false,
        }));
        state.notes ??= [];
        state.notes.unshift(card);
        dispatch("notes:updated", null);
        return clone(card);
      }
      case "update_note_card": {
        const card = (state.notes ?? []).find((c) => c.value.id === args.id);
        if (!card) throw new Error("This note no longer exists");
        if (card.value.revision !== args.expectedRevision)
          throw new Error(
            "This note changed in another window. Your draft is still here; reopen the latest note before saving.",
          );
        card.value = {
          ...card.value,
          ...clone(args.patch),
          revision: card.value.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        dispatch("notes:updated", null);
        return clone(card);
      }
      case "get_engine_status":
        return clone(state.engine);
      case "check_engine":
      case "repair_engine": {
        const response = seed.responses?.[command];
        if (!response) throw new Error(`Missing explicit ${command} fixture`);
        state.engine = clone(response);
        dispatch("engine:health", clone(state.engine));
        return clone(state.engine);
      }
      case "get_staged_url":
        return state.stagedUrl;
      case "get_captured_link":
        return clone(state.metadata ?? seed.responses?.get_captured_link ?? null);
      case "resolve_download_preset":
        return clone(
          seed.responses?.resolve_download_preset ?? {
            id: "mp4_1080",
            label: "MP4 · 1080p",
            options: { format: "mp4", height: 1080, sections: [], playlistMode: "video" },
          },
        );
      case "pause_download":
      case "cancel_download":
      case "resume_download":
      case "retry_download":
      case "retry_download_with_browser": {
        const job = state.jobs.find((j) => j.id === args.id);
        if (!job) throw new Error("Job not found");
        job.status =
          command === "pause_download"
            ? "paused"
            : command === "cancel_download"
              ? "cancelled"
              : "queued";
        job.error = null;
        dispatch("download:updated", clone(job));
        return clone(job);
      }
      case "open_download":
      case "reveal_download":
        return null;
      case "clear_finished_downloads":
        state.jobs = state.jobs.filter((j) => !["completed", "cancelled"].includes(j.status));
        dispatch("download:cleared", null);
        return null;
      case "plugin:clipboard-manager|read_text":
        return seed.clipboardText ?? null;
      case "island_review_url":
      case "capture_url": {
        const url = new globalThis.URL(args.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new Error("Enter an http or https link");
        state.stagedUrl = url.href;
        state.metadata = {
          title: url.hostname,
          duration: null,
          channel: null,
          thumbnail: null,
          isPlaylist: false,
          playlistCount: null,
          extractor: "capture",
          qualities: [],
          ...state.metadata,
          url: url.href,
          normalizedUrl: url.href,
        };
        dispatch("url:detected", clone(state.metadata));
        if (command === "island_review_url") {
          const snapshot = await invoke("get_activity_snapshot");
          snapshot.revision++;
          const event = {
            kind: "linkDetected",
            url: url.href,
            title: null,
            duration: null,
            site: url.hostname,
          };
          const item = { id: "link", category: "link", event, alert: false, bubbleOnly: false };
          for (const view of snapshot.views) view.primary = item;
          state.activity = snapshot;
          dispatch("nabbit://activity", { event, snapshot });
          dispatch("nabbit://island", { event, snapshot });
        }
        return clone(state.metadata);
      }
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
