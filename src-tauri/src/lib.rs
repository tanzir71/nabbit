mod capture;
mod clipboard;
mod commands;
mod context;
mod db;
mod download;
mod error;
mod files;
mod island;
pub mod media;
mod modes;
mod notes;
mod pins;
pub mod power;
pub mod privacy;
mod retention;
mod settings_window;
pub mod shelf;
mod shell;
mod sticky;
pub mod tack;
#[cfg(windows)]
mod taskbar_theme;
pub mod timer;
mod tools;
mod tray_icon;
mod util;

#[cfg(all(windows, feature = "island-spike"))]
#[path = "../../spikes/island/native.rs"]
mod island_spike;

#[cfg_attr(not(all(windows, feature = "island-spike")), allow(dead_code))]
#[path = "../../spikes/island/interaction.rs"]
mod island_interaction;

#[cfg(any(test, all(windows, feature = "island-spike")))]
#[cfg_attr(not(all(windows, feature = "island-spike")), allow(dead_code))]
#[path = "../../spikes/island/native_model.rs"]
mod island_native_model;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use arboard::Clipboard;
use db::{models::AppSettings, Database};
use download::manager::DownloadManager;
use error::Result;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Wry,
};
use tauri_plugin_autostart::ManagerExt as AutoStartExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone)]
pub struct AppState {
    pub capture: Arc<capture::Service>,
    pub db: Database,
    pub downloads: DownloadManager,
    pub engine: Arc<download::engine::Service>,
    pub app_data_dir: PathBuf,
    pub shutdown: Arc<AtomicBool>,
    pub settings_write: Arc<std::sync::Mutex<()>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 2 && args[1] == "--unregister-context" {
        if !context::acceptance() {
            if let Err(error) = context::registration::uninstall() {
                eprintln!("Context removal failed: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    let context = tauri::generate_context!();
    #[cfg(windows)]
    let context = {
        let mut context = context;
        let lazy = island::production_session();
        #[cfg(feature = "island-spike")]
        let lazy = lazy || island_spike::native_session();
        if lazy {
            for window in &mut context.config_mut().app.windows {
                if window.label == "main" {
                    window.create = false;
                }
            }
        }
        context
    };
    let builder = tauri::Builder::default()
        .manage(context::Service::default())
        .manage(sticky::Service::default())
        .manage(notes::links::service::Service::default())
        .manage(download::sheets::Service::default())
        .manage(tack::service::Service::default());
    let builder = if sticky::acceptance_enabled() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if context::explorer::intake(app, &args, Path::new(&cwd)) {
                return;
            }
            // The plugin's deep-link integration already delivered configured scheme arguments.
            if !args.iter().any(|arg| arg.starts_with("nabbit:")) {
                let _ = show_popover(app);
            }
        }))
    };
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            context::acceptance::context_fixture,
            context::commands::context_preferences,
            context::commands::save_context_preferences,
            context::commands::context_batch,
            context::commands::context_batch_dismiss,
            context::commands::clipboard_context,
            context::commands::clipboard_context_dismiss,
            context::commands::clipboard_transform,
            context::commands::clipboard_tool_inputs,
            context::commands::clipboard_context_action,
            tools::commands::tool_catalog,
            tools::images::commands::tool_image_inspect,
            tools::images::commands::tool_image_codec,
            tools::documents::commands::tool_pdf_pages,
            tools::commands::tool_suggest,
            tools::media::sheet::tool_open_media_sheet,
            tools::media::sheet::tool_media_sheet,
            tools::media::sheet::tool_media_sheet_ready,
            tools::media::sheet::tool_close_media_sheet,
            tools::media::sheet::tool_media_inspect,
            tools::media::sheet::tool_media_capabilities,
            tools::media::sheet::tool_media_estimate,
            files::commands::files_pins,
            files::commands::files_drop_status,
            files::commands::files_fixture_drop,
            files::commands::files_save_pin,
            files::commands::files_remove_pin,
            files::commands::files_choose,
            files::commands::files_capabilities,
            files::commands::files_download_info,
            files::commands::files_plan,
            files::commands::files_hints,
            files::commands::files_execute,
            files::commands::files_undo,
            files::commands::files_history,
            files::commands::files_suggestions,
            files::commands::files_peek_open,
            files::commands::files_peek_items,
            files::commands::files_peek_close,
            files::commands::files_pin_action,
            files::commands::files_drag_plan,
            files::commands::files_thumbnail,
            tools::commands::tool_pick_input,
            tools::commands::third_party_licenses,
            tools::commands::tool_presets,
            tools::commands::tool_save_preset,
            tools::commands::tool_jobs,
            tools::commands::tool_start,
            tools::commands::tool_cancel,
            tools::commands::tool_retry,
            tools::commands::tool_undo,
            tools::commands::tool_reveal,
            tools::commands::tool_quit,
            timer::timer_snapshot,
            timer::timer_action,
            timer::timer_view,
            timer::timer_fixture,
            power::power_snapshot,
            power::power_fixture,
            privacy::privacy_snapshot,
            privacy::privacy_fixture,
            media::media_snapshot,
            media::media_select,
            media::media_action,
            media::media_toggle,
            media::media_fixture,
            shelf::commands::shelf_list,
            shelf::commands::shelf_add,
            shelf::commands::shelf_remove,
            shelf::commands::shelf_paths,
            shelf::commands::shelf_copy_paths,
            shelf::commands::shelf_drag_plan,
            shelf::commands::shelf_preview,
            island::shelf_drag_active,
            commands::links::save_link,
            commands::links::link_clean,
            commands::links::link_open_url,
            commands::links::links_open,
            commands::links::links_bulk,
            commands::links::bookmarks_discover,
            commands::links::bookmarks_pick_html,
            commands::links::bookmarks_preview,
            commands::links::bookmarks_commit,
            commands::links::bookmarks_release,
            commands::links::bookmarks_history,
            commands::links::bookmarks_undo,
            commands::tack::tack_status,
            commands::tack::tack_snapshot,
            commands::tack::tack_login,
            commands::tack::tack_confirm_recovery,
            commands::tack::tack_switch_workspace,
            commands::tack::tack_logout,
            commands::tack::tack_sync_snapshot,
            commands::tack::tack_sync_now,
            commands::tack::tack_conflicts,
            commands::tack::tack_resolve_conflict,
            commands::tack::tack_upload_local_notes,
            commands::tack::tack_local_mode,
            commands::tack::tack_profile,
            commands::tack::tack_workspace_profile,
            commands::tack::tack_start_sync,
            commands::tack::tack_copy_recovery,
            commands::tack::tack_open,
            commands::notes::list_note_cards,
            commands::notes::get_notes_state,
            commands::notes::save_note_reminder,
            commands::notes::get_note_editor,
            commands::notes::save_note_editor,
            commands::notes::create_note_card,
            sticky::open_sticky,
            sticky::sticky_snapshot,
            sticky::sticky_ready,
            sticky::sticky_configure,
            sticky::sticky_drag,
            sticky::sticky_checkpoint,
            sticky::sticky_clear_checkpoint,
            sticky::sticky_save,
            sticky::sticky_reload,
            sticky::sticky_close,
            sticky::sticky_leave,
            sticky::sticky_save_as_new,
            commands::notes::capture_note,
            commands::notes::notes_open,
            commands::notes::take_notes_intent,
            commands::notes::update_note_card,
            download::sheets::open_download_sheet,
            download::sheets::get_download_sheet,
            download::sheets::download_sheet_ready,
            download::sheets::close_download_sheet,
            download::sheets::start_playlist_download,
            download::sheets::preview_download_source,
            commands::app::app_health,
            commands::app::check_app_update,
            commands::settings::get_settings,
            commands::settings::get_island_snapshot,
            island::island_set_hitrect,
            island::island_clear_hitrect,
            island::island_set_drag,
            island::island_wake,
            island::island_toggle_keyboard,
            island::island_keyboard_focus,
            island::island_keyboard_ready,
            pins::list_island_pins,
            pins::island_open_pin,
            island::island_open_settings,
            island::consume_island_settings_intent,
            island::get_island_surface,
            island::island_surface_request,
            island::island_surface_ack,
            island::island_stage_drop,
            island::get_island_drop,
            island::island_review_url,
            island::activity_bus::get_activity_snapshot,
            island::activity_bus::island_activity_action,
            commands::settings::save_island_preferences,
            commands::settings::save_settings,
            commands::settings::patch_settings,
            modes::get_mode_snapshot,
            modes::mode_fixture,
            settings_window::open_settings_window,
            settings_window::settings_window_ready,
            commands::settings::acknowledge_first_run,
            commands::settings::get_storage_stats,
            commands::settings::run_retention_gc,
            commands::settings::show_main_window,
            commands::settings::hide_main_window,
            commands::clipboard::list_clipboard_entries,
            commands::clipboard::add_clipboard_text,
            commands::clipboard::copy_clipboard_entry,
            island::island_clipboard_pick,
            commands::clipboard::toggle_pin_clipboard_entry,
            commands::clipboard::delete_clipboard_entry,
            commands::clipboard::clear_clipboard_history,
            commands::download::probe_url,
            commands::download::capture_url,
            commands::download::get_captured_link,
            commands::download::get_staged_url,
            commands::download::clear_staged_url,
            commands::download::start_download,
            commands::download::list_download_presets,
            commands::download::parse_download_timecode,
            commands::download::resolve_download_preset,
            commands::download::remember_download_preset,
            commands::download::start_download_with_preset,
            commands::download::list_downloads,
            commands::download::open_download,
            commands::download::clear_finished_downloads,
            commands::download::cancel_download,
            commands::download::pause_download,
            commands::download::resume_download,
            commands::download::retry_download,
            commands::download::retry_download_with_browser,
            commands::download::recover_download,
            commands::download::copy_download_details,
            commands::download::reveal_download,
            commands::download::open_downloads_folder,
            commands::download::get_engine_status,
            commands::download::check_engine,
            commands::download::repair_engine,
            commands::download::quick_download_staged,
            #[cfg(all(windows, feature = "island-spike"))]
            island_spike::island_spike_set_hitrect,
            #[cfg(all(windows, feature = "island-spike"))]
            island_spike::island_spike_set_drag,
            #[cfg(all(windows, feature = "island-spike"))]
            island_spike::island_spike_snapshot,
            #[cfg(all(windows, feature = "island-spike"))]
            island_spike::island_spike_surface,
            #[cfg(all(windows, feature = "island-spike"))]
            island_spike::island_spike_ready,
            #[cfg(all(windows, feature = "island-spike"))]
            island_spike::island_spike_handoff,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let app_data_dir = std::env::var_os("NABBIT_APP_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    app.path()
                        .app_data_dir()
                        .unwrap_or_else(|_| std::env::temp_dir().join("Nabbit"))
                });
            let db = Database::open(&app_data_dir)?;
            db.mark_interrupted_downloads()?;
            let activity_settings = db.get_settings()?.island_activity;
            app.manage(island::activity_bus::Bus::start(
                app.handle().clone(),
                activity_settings,
            ));
            app.manage(media::start(app.handle().clone()));
            app.manage(privacy::start(app.handle().clone()));
            app.manage(power::start(app.handle().clone()));
            app.manage(timer::start(app.handle().clone(), db.clone())?);
            app.manage(tools::Service::start(
                db.clone(),
                app.handle().clone(),
                app_data_dir.clone(),
            )?);
            app.manage(files::Service::new(db.clone(), app_data_dir.clone())?);
            let downloads =
                DownloadManager::new(db.clone(), app.handle().clone(), app_data_dir.clone());
            let shutdown = Arc::new(AtomicBool::new(false));
            let state = AppState {
                capture: capture::Service::new(db.clone()),
                db: db.clone(),
                downloads,
                engine: download::engine::Service::new(db.clone(), app_data_dir.clone()),
                app_data_dir,
                shutdown: shutdown.clone(),
                settings_write: Arc::default(),
            };
            app.manage(state.clone());
            app.manage(settings_window::Service::default());
            app.manage(modes::Service::start(
                app.handle().clone(),
                db.get_settings()?.display_mode,
                &db.list_downloads()?,
            ));
            app.state::<tack::service::Service>()
                .start(db.clone(), app.handle().clone())?;

            setup_tray(app.handle())?;
            #[cfg(all(windows, feature = "island-spike"))]
            island_spike::open_if_enabled(app.handle(), shutdown.clone())?;
            if !island::acceptance_session()
                && !download::acceptance::injected_clipboard()
                && !sticky::acceptance_enabled()
            {
                clipboard::watcher::spawn_clipboard_watcher(
                    app.handle().clone(),
                    db.clone(),
                    shutdown.clone(),
                );
            }
            retention::spawn_retention_gc(app.handle().clone(), db.clone(), shutdown.clone());
            spawn_acceptance_automation(app.handle().clone(), state.clone());
            let settings = db.get_settings()?;
            #[cfg(windows)]
            if island::production_session() {
                island::start(app.handle(), settings.island.clone())
                    .map_err(std::io::Error::other)?;
            }
            let configure_os_integration = {
                #[cfg(all(windows, feature = "island-spike"))]
                {
                    !island_spike::session_requested()
                }
                #[cfg(not(all(windows, feature = "island-spike")))]
                {
                    true
                }
            };
            if configure_os_integration
                && !island::acceptance_session()
                && !download::acceptance::enabled()
                && !sticky::acceptance_enabled()
            {
                apply_runtime_settings(app.handle(), &state, &settings);
                if let Err(error) =
                    context::registration::preferences(&db).and_then(context::registration::sync)
                {
                    eprintln!("Explorer integration could not be restored: {error}");
                }
            }
            context::explorer::start(app.handle())?;
            if settings.restore_sticky_notes {
                sticky::restore(app.handle());
            }
            if !sticky::acceptance_enabled() {
                state.engine.start(app.handle().clone());
                state.downloads.start_deferred();
                state
                    .capture
                    .start(app.handle().clone(), state.app_data_dir.clone());
            }
            let capture_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let _ = capture::open_deep_link(&capture_app, url.as_str());
                }
            });
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    let _ = capture::open_deep_link(app.handle(), url.as_str());
                }
            }
            if !settings.start_hidden {
                let _ = show_popover(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            sticky::event(window, event);
            if let Some(sync) = window.app_handle().try_state::<tack::service::Service>() {
                let closing = matches!(event, tauri::WindowEvent::Destroyed)
                    || (matches!(event, tauri::WindowEvent::CloseRequested { .. })
                        && !window.label().starts_with("sticky-"));
                let open = window.app_handle().webview_windows().values().any(|w| {
                    !(closing && w.label() == window.label()) && w.is_visible().unwrap_or(false)
                });
                sync.visibility(open, matches!(event, tauri::WindowEvent::Focused(true)));
            }
            if window.label() == "download-sheet" && matches!(event, tauri::WindowEvent::Destroyed)
            {
                if let Some(service) = window.app_handle().try_state::<download::sheets::Service>()
                {
                    if let Ok(mut intent) = service.0.lock() {
                        *intent = None;
                    }
                }
            }
            #[cfg(windows)]
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(manager) = window.app_handle().try_state::<Arc<island::Manager>>() {
                    let _ = manager.set_hitrect(window.label(), None);
                }
            }
            if matches!(event, tauri::WindowEvent::CloseRequested { .. })
                && window.label() == "main"
            {
                let _ = window.hide();
            }
        })
        .build(context)
        .expect("error while building Nabbit")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                if let Some(timer) = app.try_state::<Arc<timer::Service>>() {
                    timer.window_closed(label.clone());
                }
                if let Some(files) = app.try_state::<Arc<files::Service>>() {
                    files.watches.close(label, None);
                }
                #[cfg(windows)]
                files::drop::close(label);
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_some()
                    && (app
                        .try_state::<Arc<tools::Service>>()
                        .is_some_and(|s| s.active() && !s.quit_confirmed.load(Ordering::Acquire))
                        || app
                            .try_state::<Arc<files::Service>>()
                            .is_some_and(|s| s.active()))
                {
                    api.prevent_exit();
                    tools::request_quit(app);
                    return;
                }
                #[cfg(windows)]
                if island::production_session() && code.is_none() {
                    api.prevent_exit();
                    return;
                }
                #[cfg(all(windows, feature = "island-spike"))]
                if island_spike::native_session() && code.is_none() {
                    // Closing the last larger webview must leave the native pill/tray alive.
                    api.prevent_exit();
                    return;
                }
                if context::fallback::active() {
                    api.prevent_exit();
                    let _ = app.emit(
                        "capture:error",
                        "A selected-text copy is finishing. Try Quit again.",
                    );
                    return;
                }
                if context::fallback::recover().is_err() {
                    api.prevent_exit();
                    let _ = app.emit(
                        "capture:error",
                        "Clipboard restoration is still pending. Try Quit again.",
                    );
                    return;
                }
                #[cfg(not(all(windows, feature = "island-spike")))]
                let _ = (api, code);
                if let Some(state) = app.try_state::<AppState>() {
                    state.shutdown.store(true, Ordering::Relaxed);
                    state.engine.stop();
                    state.downloads.stop();
                    state.capture.stop();
                }
                if let Some(tools) = app.try_state::<Arc<tools::Service>>() {
                    tools.stop();
                }
                if let Some(modes) = app.try_state::<Arc<modes::Service>>() {
                    modes.stop();
                }
                if let Some(files) = app.try_state::<Arc<files::Service>>() {
                    files.watches.stop();
                }
                #[cfg(windows)]
                files::drop::stop();
                shell::stop();
                if let Some(bus) = app.try_state::<Arc<island::activity_bus::Bus>>() {
                    bus.stop();
                }
                if let Some(timer) = app.try_state::<Arc<timer::Service>>() {
                    timer.stop();
                }
                if let Some(privacy) = app.try_state::<Arc<privacy::Service>>() {
                    privacy.stop();
                }
                if let Some(media) = app.try_state::<Arc<media::Service>>() {
                    media.stop();
                }
                if let Some(sync) = app.try_state::<tack::service::Service>() {
                    sync.stop();
                }
                #[cfg(windows)]
                if let Some(manager) = app.try_state::<Arc<island::Manager>>() {
                    manager.stop();
                }
                #[cfg(windows)]
                if let Some(watcher) = app.try_state::<taskbar_theme::Watcher>() {
                    watcher.stop();
                }
            }
        });
}

fn spawn_acceptance_automation(app: AppHandle, state: AppState) {
    let Some(command_dir) = std::env::var_os("NABBIT_ACCEPTANCE_COMMAND_DIR").map(PathBuf::from)
    else {
        return;
    };

    let shutdown = state.shutdown.clone();
    let _ = thread::Builder::new()
        .name("nabbit-acceptance-automation".into())
        .spawn(move || {
            let _ = fs::create_dir_all(&command_dir);
            let clear_request = command_dir.join("clear-history");
            let clear_done = command_dir.join("clear-history.done");
            let download_start_request = command_dir.join("download-start.json");
            let download_start_done = command_dir.join("download-start.done");
            let download_cancel_request = command_dir.join("download-cancel.txt");
            let download_cancel_done = command_dir.join("download-cancel.done");
            let download_retry_request = command_dir.join("download-retry.txt");
            let download_retry_done = command_dir.join("download-retry.done");
            let download_list_request = command_dir.join("download-list");
            let download_list_done = command_dir.join("download-list.done");
            let probe_url_request = command_dir.join("probe-url.txt");
            let probe_url_done = command_dir.join("probe-url.done");
            let clipboard_add_request = command_dir.join("clipboard-add.json");
            let clipboard_add_done = command_dir.join("clipboard-add.done");

            let mut last_clipboard_url = None;
            while !shutdown.load(Ordering::Relaxed) {
                sticky::acceptance::process(&app, &command_dir);
                download::acceptance::process(&app, &state, &command_dir, &mut last_clipboard_url);
                if clear_request.exists() {
                    let result = state
                        .db
                        .clear_clipboard_history()
                        .map(|()| "ok".to_string())
                        .map_err(|error| error.to_string());
                    let _ = fs::remove_file(&clear_request);
                    write_acceptance_done(&clear_done, result);
                }

                if download_start_request.exists() {
                    let result = acceptance_start_download(&state, &download_start_request);
                    let _ = fs::remove_file(&download_start_request);
                    write_acceptance_done(&download_start_done, result);
                }

                if download_cancel_request.exists() {
                    let result = fs::read_to_string(&download_cancel_request)
                        .map_err(|error| error.to_string())
                        .and_then(|id| {
                            state
                                .downloads
                                .cancel(id.trim())
                                .map(|()| "ok".to_string())
                                .map_err(|error| error.to_string())
                        });
                    let _ = fs::remove_file(&download_cancel_request);
                    write_acceptance_done(&download_cancel_done, result);
                }

                if download_retry_request.exists() {
                    let result = fs::read_to_string(&download_retry_request)
                        .map_err(|error| error.to_string())
                        .and_then(|id| {
                            state
                                .downloads
                                .retry(id.trim())
                                .map_err(|error| error.to_string())
                        })
                        .and_then(|job| {
                            serde_json::to_string(&job).map_err(|error| error.to_string())
                        });
                    let _ = fs::remove_file(&download_retry_request);
                    write_acceptance_done(&download_retry_done, result);
                }

                if download_list_request.exists() {
                    let result = state
                        .db
                        .list_downloads()
                        .map_err(|error| error.to_string())
                        .and_then(|jobs| {
                            serde_json::to_string(&jobs).map_err(|error| error.to_string())
                        });
                    let _ = fs::remove_file(&download_list_request);
                    write_acceptance_done(&download_list_done, result);
                }

                if probe_url_request.exists() {
                    let result = acceptance_probe_url(&state, &probe_url_request);
                    let _ = fs::remove_file(&probe_url_request);
                    write_acceptance_done(&probe_url_done, result);
                }

                if clipboard_add_request.exists() {
                    let result = acceptance_add_clipboard(&state, &clipboard_add_request);
                    let _ = fs::remove_file(&clipboard_add_request);
                    write_acceptance_done(&clipboard_add_done, result);
                }

                thread::sleep(Duration::from_millis(100));
            }
        });
}

fn acceptance_start_download(state: &AppState, path: &Path) -> std::result::Result<String, String> {
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let request: db::models::DownloadRequest =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let job = state
        .downloads
        .enqueue(request)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&job).map_err(|error| error.to_string())
}

fn acceptance_probe_url(state: &AppState, path: &Path) -> std::result::Result<String, String> {
    let url = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let metadata = download::probe::probe(&state.app_data_dir, url.trim())
        .map_err(|error| error.to_string())?;
    let _ = state
        .db
        .set_setting_value("staged_url", &metadata.normalized_url);
    serde_json::to_string(&metadata).map_err(|error| error.to_string())
}

fn acceptance_add_clipboard(state: &AppState, path: &Path) -> std::result::Result<String, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Request {
        content: String,
        source_app: Option<String>,
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let request: Request = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let entry = state
        .db
        .add_clipboard_text(&request.content, request.source_app)
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "stored": entry.is_some() }).to_string())
}

fn write_acceptance_done(path: &Path, result: std::result::Result<String, String>) {
    let message = match result {
        Ok(value) => value,
        Err(error) => format!("error: {error}"),
    };
    let _ = fs::write(path, message);
}

pub fn show_popover(app: &AppHandle<Wry>) -> Result<()> {
    #[cfg(windows)]
    if app.get_webview_window("main").is_none() {
        let app = app.clone();
        // WebView2 creation must run outside tray/IPC event callbacks on Windows.
        std::thread::Builder::new()
            .name("nabbit-lazy-tray".into())
            .spawn(move || {
                if let Ok(window) = ensure_popover(&app) {
                    let _ = reveal_popover(&window);
                }
            })?;
        return Ok(());
    }
    let window = ensure_popover(app)?;
    reveal_popover(&window)
}

fn reveal_popover(window: &tauri::WebviewWindow) -> Result<()> {
    let _ = window.set_position(PhysicalPosition::new(100, 100));
    window.show()?;
    if !island::acceptance_session() {
        window.set_focus()?;
    }
    if let Some(sync) = window.app_handle().try_state::<tack::service::Service>() {
        sync.visibility(true, true);
    }
    Ok(())
}

fn ensure_popover(app: &AppHandle<Wry>) -> Result<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("main") {
        return Ok(window);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or_else(|| crate::error::msg("Main window configuration is missing"))?;
    // Construction can precede an explicit open (native idle / acceptance).
    // Only reveal_popover requests focus after the user opens the tray.
    Ok(tauri::WebviewWindowBuilder::from_config(app, config)?
        .focused(false)
        .focusable(!island::acceptance_session())
        .build()?)
}

fn toggle_popover(app: &AppHandle<Wry>) -> Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible()? {
            window.hide()?;
            notify_tack_visibility(app);
            return Ok(());
        }
    }
    show_popover(app)
}

pub(crate) fn notify_tack_visibility(app: &AppHandle<Wry>) {
    if let Some(sync) = app.try_state::<tack::service::Service>() {
        sync.visibility(
            app.webview_windows()
                .values()
                .any(|w| w.is_visible().unwrap_or(false)),
            false,
        );
    }
}

pub fn dispatch_island_shortcut(
    app: &AppHandle<Wry>,
    trigger: Option<&str>,
) -> std::result::Result<(), String> {
    if trigger.is_some_and(|t| {
        t.parse::<tauri_plugin_global_shortcut::Shortcut>().ok() == timer::SHORTCUT.parse().ok()
    }) {
        app.state::<Arc<timer::Service>>().hotkey();
        return Ok(());
    }
    if let Some(trigger) = trigger {
        let settings = app
            .state::<AppState>()
            .db
            .get_settings()
            .map_err(|e| e.to_string())?;
        let requested = trigger
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .map_err(|e| e.to_string())?;
        if settings
            .island_shortcut
            .trim()
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .ok()
            != Some(requested)
        {
            return Ok(());
        }
    }
    #[cfg(windows)]
    if let Some(manager) = app.try_state::<Arc<island::Manager>>() {
        if manager.toggle_keyboard()? {
            return Ok(());
        }
    }
    toggle_popover(app).map_err(|e| e.to_string())
}
pub fn register_island_shortcut(
    app: &AppHandle<Wry>,
    shortcut: &str,
) -> std::result::Result<(), String> {
    if shortcut.trim().is_empty() {
        Ok(())
    } else {
        app.global_shortcut()
            .on_shortcut(shortcut.trim(), |app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                if let Err(error) = dispatch_island_shortcut(app, Some(&shortcut.to_string())) {
                    #[cfg(windows)]
                    if let Some(manager) = app.try_state::<Arc<island::Manager>>() {
                        manager.shortcut_status(Some(error));
                    }
                    #[cfg(not(windows))]
                    let _ = error;
                }
            })
            .map_err(|e| format!("Island shortcut is unavailable: {e}"))
    }
}
pub fn apply_runtime_settings(app: &AppHandle<Wry>, state: &AppState, settings: &AppSettings) {
    let _ = app.global_shortcut().unregister_all();
    let timer_registration = app
        .global_shortcut()
        .on_shortcut(timer::SHORTCUT, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                app.state::<Arc<timer::Service>>().hotkey();
            }
        });
    app.state::<Arc<timer::Service>>()
        .shortcut_status(timer_registration.err().map(|_| {
            "Ctrl+Alt+T is unavailable. Choose the Timer tab to control your session.".into()
        }));
    let note_registration =
        app.global_shortcut()
            .on_shortcut(notes::capture::SHORTCUT, |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    notes::capture::hotkey(app);
                }
            });
    let _ = state.db.notes_shortcut_status(note_registration.is_err());
    let selection_registration = if !settings.selected_text_shortcut.trim().is_empty() {
        app.global_shortcut()
            .on_shortcut(settings.selected_text_shortcut.as_str(), |app, _, event| {
                if event.state == ShortcutState::Pressed {
                    context::selection::hotkey(app);
                }
            })
            .map_err(|_| ())
    } else {
        Ok(())
    };
    if let Ok(conn) = state.db.conn.lock() {
        let _ = notes::sync_store::set_meta(
            &conn,
            "notes/selection_shortcut_error",
            if selection_registration.is_err() {
                "The selected-text shortcut is unavailable. Choose another shortcut in Settings."
            } else {
                ""
            },
        );
    }
    let island_registration = island::keyboard::validate_shortcut(settings)
        .and_then(|()| register_island_shortcut(app, &settings.island_shortcut));
    #[cfg(windows)]
    if let Some(manager) = app.try_state::<Arc<island::Manager>>() {
        manager.shortcut_status(island_registration.err());
    }
    #[cfg(not(windows))]
    let _ = island_registration;

    if !settings.toggle_popover_shortcut.trim().is_empty() {
        let _ = app.global_shortcut().on_shortcut(
            settings.toggle_popover_shortcut.as_str(),
            |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = toggle_popover(app);
                }
            },
        );
    }

    if !settings.quick_download_shortcut.trim().is_empty() {
        let _ = app.global_shortcut().on_shortcut(
            settings.quick_download_shortcut.as_str(),
            |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    capture::hotkey(app);
                }
            },
        );
    }

    if !settings.clipboard_search_shortcut.trim().is_empty() {
        let _ = app.global_shortcut().on_shortcut(
            settings.clipboard_search_shortcut.as_str(),
            |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = commands::settings::patch(
                            app,
                            &state,
                            serde_json::json!({"lastTab":"clipboard"}),
                        );
                    }
                    let _ = show_popover(app);
                    let _ = app.emit("shortcut:clipboard-search", ());
                }
            },
        );
    }

    let autolaunch = app.autolaunch();
    if settings.launch_at_login {
        let _ = autolaunch.enable();
    } else {
        let _ = autolaunch.disable();
    }

    let _ = state;
}

fn setup_tray(app: &AppHandle<Wry>) -> Result<()> {
    let mode = app.state::<AppState>().db.get_settings()?.display_mode;
    let mode_items = [
        CheckMenuItem::with_id(
            app,
            modes::MENU_IDS[0],
            "Island + tray",
            true,
            mode == modes::MODES[0],
            None::<&str>,
        )?,
        CheckMenuItem::with_id(
            app,
            modes::MENU_IDS[1],
            "Tray only",
            true,
            mode == modes::MODES[1],
            None::<&str>,
        )?,
        CheckMenuItem::with_id(
            app,
            modes::MENU_IDS[2],
            "Island only",
            true,
            mode == modes::MODES[2],
            None::<&str>,
        )?,
    ];
    let mode_menu = Submenu::with_items(
        app,
        "Mode",
        true,
        &[&mode_items[0], &mode_items[1], &mode_items[2]],
    )?;
    let open = MenuItem::with_id(app, "open", "Open Nabbit", true, None::<&str>)?;
    let paste_last = MenuItem::with_id(app, "paste_last", "Paste last item", true, None::<&str>)?;
    let clear = MenuItem::with_id(
        app,
        "clear_history",
        "Clear clipboard history",
        true,
        None::<&str>,
    )?;
    let downloads = MenuItem::with_id(
        app,
        "downloads_folder",
        "Downloads folder",
        true,
        None::<&str>,
    )?;
    let pause = MenuItem::with_id(app, "pause_detect", "Pause auto-detect", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &mode_menu,
            &paste_last,
            &clear,
            &downloads,
            &pause,
            &quit,
        ],
    )?;

    let tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Nabbit")
        .icon(tray_icon::image(
            tray_icon::initial_theme(),
            tray_icon::physical_size(),
        )?)
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = toggle_popover(app);
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match modes::menu_action(app, id) {
                Ok(true) => return,
                Err(error) => {
                    eprintln!("Mode could not be changed: {error}");
                    app.state::<Arc<modes::Service>>().refresh();
                    return;
                }
                Ok(false) => {}
            }
            match id {
                "open" => {
                    let _ = show_popover(app);
                }
                "paste_last" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(entries) = state.db.list_clipboard_entries(None) {
                            if let Some(entry) = entries.first() {
                                if let Ok(mut clipboard) = Clipboard::new() {
                                    let _ = clipboard.set_text(entry.content.clone());
                                    let _ = state.db.touch_clipboard_entry(&entry.id);
                                    let _ = app.emit("clipboard:changed", ());
                                }
                            }
                        }
                    }
                }
                "clear_history" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.db.clear_clipboard_history();
                        let _ = app.emit("clipboard:changed", ());
                    }
                }
                "downloads_folder" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        let settings = state.db.get_settings().unwrap_or_default();
                        let output = if settings.output_dir.trim().is_empty() {
                            util::default_output_dir()
                        } else {
                            settings.output_dir
                        };
                        let _ = std::fs::create_dir_all(&output);
                        let _ = open::that(output);
                    }
                }
                "pause_detect" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut settings) = state.db.get_settings() {
                            settings.pause_auto_detect = !settings.pause_auto_detect;
                            let _ = commands::settings::patch(
                                app,
                                &state,
                                serde_json::json!({"pauseAutoDetect":settings.pause_auto_detect}),
                            );
                        }
                    }
                }
                "quit" => tools::request_quit(app),
                _ => {}
            }
        })
        .build(app)?;
    tray.set_visible(mode != db::models::DisplayMode::IslandOnly)?;
    app.state::<Arc<modes::Service>>()
        .menu(modes::ModeMenu(mode_items));
    #[cfg(windows)]
    {
        let handle = app.clone();
        match taskbar_theme::Watcher::start(move |theme| {
            // Re-render the current progress badge in the new taskbar theme.
            // Never wait for the UI from this worker: shutdown joins it.
            if let Some(service) = handle.try_state::<Arc<modes::Service>>() {
                service.theme(theme);
            }
        }) {
            Ok(watcher) => {
                app.manage(watcher);
            }
            Err(error) => eprintln!("Taskbar theme notifications unavailable: {error}"),
        }
    }
    Ok(())
}
