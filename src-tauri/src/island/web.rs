//! Larger WebView ownership. Constructors run off the Windows callback thread.
use super::*;
use crate::island::{
    activity::{Snapshot as ActivitySnapshot, View},
    presentation,
    surface::{Mode, Session},
};
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instruction {
    focus_tab: Option<String>,
    label: String,
    generation: u64,
    state: Mode,
    owner: &'static str,
    shape: Shape,
    reduced_motion: bool,
    width: f32,
    height: f32,
    snapshot: ActivitySnapshot,
}
fn base(view: Option<&View>) -> Mode {
    match view {
        Some(view) if view.gate == Gate::Hidden => Mode::Hidden,
        Some(view) if view.primary.is_some() => Mode::Live,
        Some(view) if view.gate == Gate::Faded => Mode::Faded,
        _ => Mode::Idle,
    }
}
pub(super) fn reduced_motion() -> bool {
    let mut enabled = 1i32;
    unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut enabled as *mut i32).cast(),
            0,
        );
    }
    enabled == 0
        || super::super::acceptance_session()
            && std::env::var("NABBIT_ACCEPTANCE_REDUCED_MOTION").as_deref() == Ok("1")
}
impl Manager {
    pub(super) fn position_surface(&self, placement: &Placement) -> Result<(), String> {
        if let Some(window) = self.app.get_webview_window(&placement.label) {
            self.place_web(&window, placement)?;
        }
        Ok(())
    }
    fn place_web(
        &self,
        window: &tauri::WebviewWindow,
        placement: &Placement,
    ) -> Result<(), String> {
        window
            .set_position(tauri::PhysicalPosition::new(
                placement.bounds.x,
                placement.bounds.y,
            ))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::PhysicalSize::new(
                placement.bounds.width,
                placement.bounds.height,
            ))
            .map_err(|e| e.to_string())?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let actual = unsafe { GetDpiForWindow(hwnd as HWND) } as f64 / 96.0;
        window
            .set_zoom(placement.render_scale / actual)
            .map_err(|e| e.to_string())
    }
    fn surface_disconnected(&self, label: &str, hwnd: isize) {
        let snapshot = self
            .app
            .state::<Arc<crate::island::activity_bus::Bus>>()
            .snapshot();
        let mut state = lock(&self.state);
        let Some(surface) = state.surfaces.get_mut(label) else {
            return;
        };
        if surface.web_hwnd != hwnd {
            return;
        }
        surface.web_hwnd = 0;
        if !surface.web_allocated {
            return;
        }
        surface.web_allocated = false;
        surface.web_owner = false;
        surface.opening = false;
        surface.request(base(snapshot.views.iter().find(|view| view.label == label)));
        let host = state.hosts.get(label).cloned();
        if let Some(input) = state.inputs.get_mut(label) {
            input.web = false;
            input.dirty = true;
        }
        drop(state);
        if let Some(host) = host {
            GRAPHICS.with(|graphics| {
                if let Some(renderer) = graphics.borrow_mut().get_mut(&host.hwnd) {
                    let _ = renderer.native_owner(true);
                }
            });
        }
        self.watcher.wake();
    }
    pub fn surface_instruction(&self, label: &str) -> Result<Instruction, String> {
        let snapshot = self
            .app
            .state::<Arc<super::super::activity_bus::Bus>>()
            .snapshot();
        let state = lock(&self.state);
        let host = state
            .hosts
            .get(label)
            .ok_or("Only an active island can request a surface")?;
        let default = Session::default();
        let surface = state.surfaces.get(label).unwrap_or(&default);
        let scene = presentation::compact(
            snapshot.views.iter().find(|view| view.label == label),
            host.placement.shape,
        );
        Ok(Instruction {
            focus_tab: surface.focus_tab.clone(),
            label: label.into(),
            generation: surface.generation,
            state: surface.state,
            owner: if surface.state.compact() {
                "native"
            } else {
                "webview"
            },
            shape: host.placement.shape,
            reduced_motion: reduced_motion(),
            width: scene.width,
            height: scene.height,
            snapshot,
        })
    }
    pub fn request_surface(&self, label: &str, next: Mode) -> Result<(), String> {
        let mut state = lock(&self.state);
        if !state.hosts.contains_key(label) {
            return Err("Only an active island can request a surface".into());
        }
        state.surfaces.entry(label.into()).or_default().pending = Some(next);
        if let Some(input) = state.inputs.get_mut(label) {
            input.dirty = true;
        }
        drop(state);
        self.watcher.wake();
        Ok(())
    }
    pub fn surface_ack(&self, label: &str, generation: u64) -> Result<(), String> {
        let this = current().ok_or("Island manager is unavailable")?;
        let label = label.to_owned();
        self.app
            .run_on_main_thread(move || {
                let result = (|| -> Result<(), String> {
                    let (destroy, hwnd) = {
                        let mut state = lock(&this.state);
                        let host = state.hosts.get(&label).ok_or("Island was removed")?.clone();
                        let surface = state
                            .surfaces
                            .get_mut(&label)
                            .ok_or("Missing surface session")?;
                        if !surface.acknowledge(generation) {
                            return Ok(());
                        }
                        surface.focus_tab = None;
                        (!surface.web_owner, host.hwnd)
                    };
                    GRAPHICS.with(|graphics| {
                        graphics
                            .borrow_mut()
                            .get_mut(&hwnd)
                            .ok_or("Missing renderer".to_string())?
                            .native_owner(destroy)
                            .map_err(|e| e.to_string())
                    })?;
                    if destroy {
                        if let Some(window) = this.app.get_webview_window(&label) {
                            window.destroy().map_err(|e| e.to_string())?;
                        }
                        let mut state = lock(&this.state);
                        let rect = state
                            .compact_motion
                            .get(&label)
                            .map(|(m, t)| m.at(t.elapsed().as_secs_f64()))
                            .map(|g| crate::island_interaction::Rect {
                                x: g.x() as f64 - 8.0,
                                y: g.top as f64 - 8.0,
                                w: g.width as f64 + 16.0,
                                h: g.height as f64 + 16.0,
                            });
                        if let Some(input) = state.inputs.get_mut(&label) {
                            input.web = false;
                            input.dirty = true;
                            if let Some(rect) = rect {
                                input.model.hitrect = Some(rect);
                            }
                            input.model.cancel_drag();
                        }
                    }
                    this.watcher.wake();
                    Ok(())
                })();
                if let Err(error) = result {
                    lock(&this.state).error = Some(error);
                }
            })
            .map_err(|e| e.to_string())
    }
    pub fn stage_drop(
        &self,
        label: &str,
        payload: serde_json::Value,
        zone: &str,
    ) -> Result<(), String> {
        let payload: crate::island::surface::DropPayload =
            serde_json::from_value(payload).map_err(|_| "Invalid drop payload")?;
        payload.validate(zone)?;
        let mut state = lock(&self.state);
        if !state.hosts.contains_key(label) {
            return Err("Island was removed".into());
        }
        state.drop_drafts.insert(
            label.into(),
            serde_json::json!({"zone":zone,"payload":payload}),
        );
        Ok(())
    }
    pub fn drop_draft(&self, label: &str) -> Option<serde_json::Value> {
        lock(&self.state).drop_drafts.get(label).cloned()
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) fn sample_surface(
        &self,
        state: &mut State,
        label: &str,
        inside: bool,
        dragging: bool,
        left: bool,
        now: u64,
        view: Option<&View>,
    ) -> bool {
        let mode = base(view);
        let surface = state.surfaces.entry(label.into()).or_default();
        surface.sample(inside, dragging, left, now, mode);
        if view.is_some_and(|view| view.fullscreen) && !surface.state.compact() {
            surface.pending = Some(mode);
        }
        surface.pending.is_some()
    }
    pub(super) fn flush_surfaces(&self) -> Result<(), String> {
        let snapshot = self
            .app
            .state::<Arc<super::super::activity_bus::Bus>>()
            .snapshot();
        let hosts: Vec<_> = lock(&self.state).hosts.values().cloned().collect();
        let reduced = reduced_motion();
        for host in hosts {
            let label = &host.placement.label;
            let view = snapshot.views.iter().find(|view| &view.label == label);
            let compact = base(view);
            let (changed, open, allocated, native_owner) = {
                let mut state = lock(&self.state);
                let surface = state.surfaces.entry(label.clone()).or_default();
                let requested = surface.pending.take();
                let desired = if compact == Mode::Hidden || view.is_some_and(|view| view.fullscreen)
                {
                    compact
                } else {
                    requested.unwrap_or(if surface.state.compact() {
                        compact
                    } else {
                        surface.state
                    })
                };
                let desired =
                    if desired == Mode::Peek && view.and_then(|v| v.primary.as_ref()).is_none() {
                        compact
                    } else {
                        desired
                    };
                let changed = surface.request(desired);
                let open = !surface.state.compact() && !surface.web_allocated && !surface.opening;
                if open {
                    surface.opening = true;
                }
                (changed, open, surface.web_allocated, !surface.web_owner)
            };
            let scene = presentation::compact(view, host.placement.shape);
            let motion = GRAPHICS.with(|graphics| -> Result<_, String> {
                let mut graphics = graphics.borrow_mut();
                let renderer = graphics.get_mut(&host.hwnd).ok_or("Missing renderer")?;
                renderer
                    .compact(&host.placement, &scene, reduced)
                    .map_err(|e| e.to_string())?;
                renderer
                    .native_owner(native_owner)
                    .map_err(|e| e.to_string())?;
                Ok((renderer.geometry(), renderer.commits))
            })?;
            {
                let mut state = lock(&self.state);
                if let Some(geometry) = motion.0 {
                    let target = crate::island::motion::Geometry::from(&scene);
                    if state.compact_motion.get(label).is_none_or(|(m, _)| {
                        m.to.width != target.width
                            || m.to.height != target.height
                            || m.to.top != target.top
                            || m.to.primary != target.primary
                    }) {
                        state.compact_motion.insert(
                            label.clone(),
                            (
                                crate::island::motion::Motion::new(geometry, target, reduced),
                                Instant::now(),
                            ),
                        );
                    }
                    if let Some(input) = state.inputs.get_mut(label) {
                        if !input.web {
                            input.model.hitrect = Some(crate::island_interaction::Rect {
                                x: geometry.x() as f64 - 8.0,
                                y: geometry.top as f64 - 8.0,
                                w: geometry.width as f64 + 16.0,
                                h: geometry.height as f64 + 16.0,
                            });
                        }
                    }
                }
                if let Some(value) = state.hosts.get_mut(label) {
                    value.commits = motion.1;
                }
            }
            if open {
                let this = current().ok_or("Island manager is unavailable")?;
                let label = label.clone();
                std::thread::Builder::new()
                    .name("nabbit-island-webview".into())
                    .spawn(move || {
                        if let Err(error) = this.build_surface(&label) {
                            let mut state = lock(&this.state);
                            if let Some(surface) = state.surfaces.get_mut(&label) {
                                surface.opening = false;
                            }
                            state.error = Some(error);
                        }
                    })
                    .map_err(|e| e.to_string())?;
            } else if changed && allocated {
                if let Some(window) = self.app.get_webview_window(label) {
                    let _ =
                        window.emit("nabbit://island-surface", self.surface_instruction(label)?);
                }
            }
        }
        Ok(())
    }
    fn build_surface(self: &Arc<Self>, label: &str) -> Result<(), String> {
        if self.app.get_webview_window(label).is_some() {
            return Err("An island webview already exists".into());
        }
        let placement = lock(&self.state)
            .hosts
            .get(label)
            .ok_or("Island was removed")?
            .placement
            .clone();
        let window = tauri::WebviewWindowBuilder::new(
            &self.app,
            label,
            tauri::WebviewUrl::App("island.html".into()),
        )
        .title("Nabbit island")
        .inner_size(720.0, 460.0)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .no_redirection_bitmap(true)
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(
                placement.bounds.x,
                placement.bounds.y,
            ))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::PhysicalSize::new(
                placement.bounds.width,
                placement.bounds.height,
            ))
            .map_err(|e| e.to_string())?;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let weak = Arc::downgrade(self);
        let closed_label = label.to_owned();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(manager) = weak.upgrade() {
                    manager.surface_disconnected(&closed_label, hwnd);
                }
            }
        });
        let actual = unsafe { GetDpiForWindow(hwnd as HWND) } as f64 / 96.0;
        window
            .set_zoom(placement.render_scale / actual)
            .map_err(|e| e.to_string())?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|e| e.to_string())?;
        crate::island::files::install(&window).map_err(|e| e.to_string())?;
        let this = self.clone();
        let label = label.to_owned();
        self.app
            .run_on_main_thread(move || {
                let result = (|| -> Result<(), String> {
                    let mut state = lock(&this.state);
                    if !state.hosts.contains_key(&label)
                        || state
                            .surfaces
                            .get(&label)
                            .is_none_or(|surface| surface.state.compact())
                    {
                        if let Some(surface) = state.surfaces.get_mut(&label) {
                            surface.opening = false;
                        }
                        drop(state);
                        window.destroy().map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                    let surface = state
                        .surfaces
                        .get_mut(&label)
                        .ok_or("Missing surface session")?;
                    surface.opening = false;
                    surface.web_allocated = true;
                    surface.web_hwnd = hwnd;
                    if let Some(input) = state.inputs.get_mut(&label) {
                        input.dirty = true;
                    }
                    drop(state);
                    let placement = lock(&this.state)
                        .hosts
                        .get(&label)
                        .ok_or("Island was removed")?
                        .placement
                        .clone();
                    this.place_web(&window, &placement)?;
                    unsafe {
                        ShowWindow(hwnd as HWND, SW_SHOWNOACTIVATE);
                    }
                    window
                        .emit("nabbit://island-surface", this.surface_instruction(&label)?)
                        .map_err(|e| e.to_string())?;
                    this.watcher.wake();
                    Ok(())
                })();
                if let Err(error) = result {
                    lock(&this.state).error = Some(error);
                }
            })
            .map_err(|e| e.to_string())
    }
    pub(super) fn native_click(&self, hwnd: isize, point: LPARAM) {
        let host = lock(&self.state)
            .hosts
            .iter()
            .find(|(_, host)| host.hwnd == hwnd)
            .map(|(_, host)| host.clone());
        if let Some(host) = host {
            let label = &host.placement.label;
            let snapshot = self
                .app
                .state::<Arc<crate::island::activity_bus::Bus>>()
                .snapshot();
            let view = snapshot.views.iter().find(|view| &view.label == label);
            let scene = presentation::compact(view, host.placement.shape);
            let x = (point as u16 as i16) as f32 / host.placement.render_scale as f32
                - (720.0 - scene.width) / 2.0;
            let y = ((point as u32 >> 16) as u16 as i16) as f32
                / host.placement.render_scale as f32
                - scene.top;
            let button=scene.primary.iter().any(|draw|matches!(draw,presentation::Draw::Button{x:left,width,..} if (5.0..=27.0).contains(&y)&&x>=*left&&x<=*left+*width));
            if button {
                if let Some(crate::island::activity::Item {
                    event: crate::island::activity::ActivityEvent::DownloadDone { job_id, .. },
                    ..
                }) = view.and_then(|view| view.primary.as_ref())
                {
                    if let Err(error) = crate::commands::download::reveal_download(
                        self.app.state::<crate::AppState>(),
                        job_id.clone(),
                    ) {
                        lock(&self.state).error = Some(error.to_string());
                    }
                    return;
                }
            }
            let item = if x > scene.primary_width && view.is_some_and(|view| view.bubble.is_some())
            {
                view.and_then(|view| view.bubble.as_ref())
            } else if button {
                view.and_then(|view| view.primary.as_ref())
            } else {
                None
            };
            if let Some(item) = item {
                use crate::island::activity::ActivityEvent;
                let tab = match item.event {
                    ActivityEvent::NoteSaved { .. } | ActivityEvent::LinkSaved { .. } => "notes",
                    ActivityEvent::MediaChanged { .. } | ActivityEvent::VolumeChanged { .. } => {
                        "media"
                    }
                    ActivityEvent::TimerTick { .. } | ActivityEvent::TimerEnded { .. } => "timer",
                    ActivityEvent::FilesMoved { .. }
                    | ActivityEvent::ToolJob { .. }
                    | ActivityEvent::ToolResult { .. } => "files",
                    _ => "nab",
                };
                lock(&self.state)
                    .surfaces
                    .entry(label.clone())
                    .or_default()
                    .focus_tab = Some(tab.into());
            }
            let _ = self.request_surface(label, Mode::Expanded);
        }
    }
}
