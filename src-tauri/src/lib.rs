mod clipboard;
mod commands;
mod db;
mod download;
mod error;
mod island;
mod pins;
mod retention;
#[cfg(windows)]
mod taskbar_theme;
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
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, Wry,
};
use tauri_plugin_autostart::ManagerExt as AutoStartExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Clone)]
pub struct AppState {
    pub db: Database,
    pub downloads: DownloadManager,
    pub engine: Arc<download::engine::Service>,
    pub app_data_dir: PathBuf,
    pub shutdown: Arc<AtomicBool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_popover(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
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
            commands::settings::acknowledge_first_run,
            commands::settings::get_storage_stats,
            commands::settings::run_retention_gc,
            commands::settings::show_main_window,
            commands::settings::hide_main_window,
            commands::clipboard::list_clipboard_entries,
            commands::clipboard::add_clipboard_text,
            commands::clipboard::copy_clipboard_entry,
            commands::clipboard::toggle_pin_clipboard_entry,
            commands::clipboard::delete_clipboard_entry,
            commands::clipboard::clear_clipboard_history,
            commands::download::probe_url,
            commands::download::get_staged_url,
            commands::download::clear_staged_url,
            commands::download::start_download,
            commands::download::list_downloads,
            commands::download::cancel_download,
            commands::download::pause_download,
            commands::download::resume_download,
            commands::download::retry_download,
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
            let downloads =
                DownloadManager::new(db.clone(), app.handle().clone(), app_data_dir.clone());
            let shutdown = Arc::new(AtomicBool::new(false));
            let state = AppState {
                db: db.clone(),
                downloads,
                engine: download::engine::Service::new(db.clone(), app_data_dir.clone()),
                app_data_dir,
                shutdown: shutdown.clone(),
            };
            app.manage(state.clone());

            setup_tray(app.handle())?;
            #[cfg(all(windows, feature = "island-spike"))]
            island_spike::open_if_enabled(app.handle(), shutdown.clone())?;
            if !island::acceptance_session() {
                clipboard::watcher::spawn_clipboard_watcher(
                    app.handle().clone(),
                    db.clone(),
                    shutdown.clone(),
                );
            }
            retention::spawn_retention_gc(db.clone(), shutdown.clone());
            spawn_acceptance_automation(state.clone());
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
            if configure_os_integration && !island::acceptance_session() {
                apply_runtime_settings(app.handle(), &state, &settings);
            }
            state.engine.start(app.handle().clone());
            if !settings.start_hidden {
                let _ = show_popover(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
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
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
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
                #[cfg(not(all(windows, feature = "island-spike")))]
                let _ = (api, code);
                if let Some(state) = app.try_state::<AppState>() {
                    state.shutdown.store(true, Ordering::Relaxed);
                    state.engine.stop();
                }
                if let Some(bus) = app.try_state::<Arc<island::activity_bus::Bus>>() {
                    bus.stop();
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

fn spawn_acceptance_automation(state: AppState) {
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

            while !shutdown.load(Ordering::Relaxed) {
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
    window.set_focus()?;
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
        .build()?)
}

fn toggle_popover(app: &AppHandle<Wry>) -> Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible()? {
            window.hide()?;
            return Ok(());
        }
    }
    show_popover(app)
}

pub fn dispatch_island_shortcut(
    app: &AppHandle<Wry>,
    trigger: Option<&str>,
) -> std::result::Result<(), String> {
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
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(Some(url)) = state.db.setting_value("staged_url") {
                            if let Ok(settings) = state.db.get_settings() {
                                let request = db::models::DownloadRequest {
                                    url,
                                    quality: settings.default_quality,
                                    playlist_mode: "video".into(),
                                    playlist_range: None,
                                };
                                let _ = state.downloads.enqueue(request);
                            }
                        }
                    }
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
                        if let Ok(mut settings) = state.db.get_settings() {
                            settings.last_tab = "clipboard".into();
                            let _ = state.db.save_settings(&settings);
                        }
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
        &[&open, &paste_last, &clear, &downloads, &pause, &quit],
    )?;

    TrayIconBuilder::with_id("main-tray")
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
                                }
                            }
                        }
                    }
                }
                "clear_history" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        let _ = state.db.clear_clipboard_history();
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
                            let _ = state.db.save_settings(&settings);
                        }
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    #[cfg(windows)]
    {
        let handle = app.clone();
        match taskbar_theme::Watcher::start(move |theme| {
            let app = handle.clone();
            // Never wait for the UI from the worker: shutdown joins this thread.
            let _ = handle.run_on_main_thread(move || {
                if let Some(tray) = app.tray_by_id("main-tray") {
                    match tray_icon::image(theme, tray_icon::physical_size())
                        .and_then(|image| tray.set_icon(Some(image)))
                    {
                        Ok(()) => {}
                        Err(error) => eprintln!("Could not update taskbar glyph: {error}"),
                    }
                }
            });
        }) {
            Ok(watcher) => {
                app.manage(watcher);
            }
            Err(error) => eprintln!("Taskbar theme notifications unavailable: {error}"),
        }
    }
    Ok(())
}
