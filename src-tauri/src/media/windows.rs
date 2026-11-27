//! GSMTC and Core Audio live on one MTA actor. Every idle wait is a blocking recv.
use super::*;
use ::windows::{
    core::{implement, Error, Result as WinResult, PCWSTR},
    Foundation::TypedEventHandler,
    Media::Control::{
        GlobalSystemMediaTransportControlsSession as MediaSession,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    },
    Storage::Streams::DataReader,
    Win32::{
        Foundation::{E_FAIL, PROPERTYKEY},
        Media::Audio::{Endpoints::*, *},
        System::{
            Com::{CoCreateInstance, CLSCTX_ALL},
            WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
    },
};
use std::{
    future::IntoFuture,
    sync::mpsc,
    time::{Duration, Instant},
};
enum Notice {
    Sessions,
    Current,
    Metadata(String),
    Playback(String),
    Timeline(String),
    Volume,
    Endpoint,
    Resume,
    Stop,
    Action(Action, mpsc::Sender<Result<(), String>>, Instant),
}
pub struct Provider {
    tx: mpsc::Sender<Notice>,
    rx: Mutex<Option<mpsc::Receiver<Notice>>>,
}
impl Provider {
    pub fn new() -> Arc<Self> {
        let (tx, rx) = mpsc::channel();
        Arc::new(Self {
            tx,
            rx: Mutex::new(Some(rx)),
        })
    }
}
impl MediaProvider for Provider {
    fn subscribe(&self, sink: Sink) -> Result<(), String> {
        let rx = self
            .rx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or("Already subscribed")?;
        let tx = self.tx.clone();
        std::thread::Builder::new()
            .name("nabbit-media".into())
            .spawn(move || {
                if let Err(error) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
                    sink(Snapshot {
                        error: Some(error.to_string()),
                        ..Snapshot::default()
                    });
                    return;
                }
                {
                    let mut actor = Actor {
                        tx,
                        sink,
                        manager: None,
                        manager_tokens: vec![],
                        sessions: vec![],
                        next_id: 0,
                        snapshot: Snapshot::default(),
                        audio: None,
                        enumerator: None,
                        device_callback: None,
                    };
                    actor.rebind();
                    while let Ok(notice) = rx.recv() {
                        match notice {
                            Notice::Stop => break,
                            Notice::Resume => actor.rebind(),
                            Notice::Action(action, reply, deadline) => {
                                let result = if Instant::now() >= deadline {
                                    Err("Media control expired.".into())
                                } else {
                                    actor.perform(action)
                                };
                                let _ = reply.send(result);
                            }
                            Notice::Endpoint => {
                                actor.bind_audio();
                                actor.emit();
                            }
                            Notice::Volume => {
                                actor.read_volume();
                                actor.emit();
                            }
                            Notice::Sessions => {
                                if let Err(e) = actor.reconcile() {
                                    actor.snapshot.error = Some(e.to_string());
                                }
                                actor.emit();
                            }
                            Notice::Current => {
                                actor.current();
                                actor.emit();
                            }
                            Notice::Metadata(id) => {
                                actor.refresh(&id, true);
                                actor.emit();
                            }
                            Notice::Playback(id) | Notice::Timeline(id) => {
                                actor.refresh(&id, false);
                                actor.emit();
                            }
                        }
                    }
                    actor.clear();
                }
                unsafe { RoUninitialize() };
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn perform(&self, action: Action) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Notice::Action(
                action,
                tx,
                Instant::now() + Duration::from_secs(8),
            ))
            .map_err(|_| "Media provider has stopped.")?;
        rx.recv_timeout(Duration::from_secs(8))
            .map_err(|_| "Media control timed out.")?
    }
    fn resume(&self) {
        let _ = self.tx.send(Notice::Resume);
    }
    fn stop(&self) {
        let _ = self.tx.send(Notice::Stop);
    }
}
macro_rules! wait {
    ($operation:expr) => {{
        let op = $operation?;
        let future = op.clone().into_future();
        match tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), future).await
        }) {
            Ok(result) => result,
            Err(_) => {
                let _ = op.Cancel();
                Err(Error::new(E_FAIL, "Media player timed out"))
            }
        }
    }};
}
struct Entry {
    native: MediaSession,
    data: Session,
    tokens: Vec<(u8, i64)>,
}
impl Drop for Entry {
    fn drop(&mut self) {
        for (kind, token) in &self.tokens {
            let _ = match kind {
                0 => self.native.RemoveMediaPropertiesChanged(*token),
                1 => self.native.RemovePlaybackInfoChanged(*token),
                _ => self.native.RemoveTimelinePropertiesChanged(*token),
            };
        }
    }
}
struct Actor {
    tx: mpsc::Sender<Notice>,
    sink: Sink,
    manager: Option<Manager>,
    manager_tokens: Vec<(u8, i64)>,
    sessions: Vec<Entry>,
    next_id: u64,
    snapshot: Snapshot,
    audio: Option<(IAudioEndpointVolume, IAudioEndpointVolumeCallback)>,
    enumerator: Option<IMMDeviceEnumerator>,
    device_callback: Option<IMMNotificationClient>,
}
impl Actor {
    fn clear(&mut self) {
        self.sessions.clear();
        if let Some(m) = self.manager.take() {
            for (kind, token) in self.manager_tokens.drain(..) {
                let _ = if kind == 0 {
                    m.RemoveSessionsChanged(token)
                } else {
                    m.RemoveCurrentSessionChanged(token)
                };
            }
        }
        self.unbind_audio();
        if let (Some(e), Some(c)) = (self.enumerator.take(), self.device_callback.take()) {
            let _ = unsafe { e.UnregisterEndpointNotificationCallback(&c) };
        }
    }
    fn rebind(&mut self) {
        self.clear();
        self.snapshot = Snapshot::default();
        let result = (|| -> WinResult<()> {
            let manager = wait!(Manager::RequestAsync())?;
            self.manager = Some(manager.clone());
            let tx = self.tx.clone();
            let token = manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
                let _ = tx.send(Notice::Sessions);
                Ok(())
            }))?;
            self.manager_tokens.push((0, token));
            let tx = self.tx.clone();
            let token = manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
                let _ = tx.send(Notice::Current);
                Ok(())
            }))?;
            self.manager_tokens.push((1, token));
            self.reconcile()
        })();
        if let Err(e) = result {
            self.snapshot.error = Some(e.to_string());
        }
        self.bind_audio();
        self.emit();
    }
    fn reconcile(&mut self) -> WinResult<()> {
        let manager = self
            .manager
            .as_ref()
            .ok_or_else(|| Error::new(E_FAIL, "No media manager"))?
            .clone();
        let native = manager.GetSessions()?;
        let mut old = std::mem::take(&mut self.sessions);
        for session in native {
            if let Some(index) = old.iter().position(|e| e.native == session) {
                self.sessions.push(old.remove(index));
                continue;
            }
            self.next_id += 1;
            let id = format!("session-{}", self.next_id);
            let mut entry = Entry {
                native: session.clone(),
                data: Session {
                    id: id.clone(),
                    app: application_name(&session.SourceAppUserModelId()?.to_string()),
                    ..Session::default()
                },
                tokens: vec![],
            };
            let tx = self.tx.clone();
            let key = id.clone();
            let token = session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                let _ = tx.send(Notice::Metadata(key.clone()));
                Ok(())
            }))?;
            entry.tokens.push((0, token));
            let tx = self.tx.clone();
            let key = id.clone();
            let token = session.PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                let _ = tx.send(Notice::Playback(key.clone()));
                Ok(())
            }))?;
            entry.tokens.push((1, token));
            let tx = self.tx.clone();
            let key = id.clone();
            let token =
                session.TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                    let _ = tx.send(Notice::Timeline(key.clone()));
                    Ok(())
                }))?;
            entry.tokens.push((2, token));
            self.sessions.push(entry);
            self.refresh(&id, true);
        }
        // Old registrations are revoked here, including removed sessions.
        drop(old);
        self.current();
        Ok(())
    }
    fn current(&mut self) {
        self.snapshot.selected = self
            .manager
            .as_ref()
            .and_then(|m| m.GetCurrentSession().ok())
            .and_then(|n| {
                self.sessions
                    .iter()
                    .find(|e| e.native == n)
                    .map(|e| e.data.id.clone())
            });
    }
    fn refresh(&mut self, id: &str, metadata: bool) {
        let Some(entry) = self.sessions.iter_mut().find(|e| e.data.id == id) else {
            return;
        };
        if let Err(e) = read_session(entry, metadata) {
            self.snapshot.error = Some(e.to_string());
        }
    }
    fn emit(&mut self) {
        self.snapshot.sessions = self.sessions.iter().map(|e| e.data.clone()).collect();
        (self.sink)(self.snapshot.clone());
    }
    fn unbind_audio(&mut self) {
        if let Some((volume, callback)) = self.audio.take() {
            let _ = unsafe { volume.UnregisterControlChangeNotify(&callback) };
        }
        self.snapshot.volume = None;
    }
    fn bind_audio(&mut self) {
        self.unbind_audio();
        let result = (|| -> WinResult<()> {
            unsafe {
                if self.enumerator.is_none() {
                    let e: IMMDeviceEnumerator =
                        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                    let callback: IMMNotificationClient = Devices(self.tx.clone()).into();
                    e.RegisterEndpointNotificationCallback(&callback)?;
                    self.enumerator = Some(e);
                    self.device_callback = Some(callback);
                }
                let volume: IAudioEndpointVolume = self
                    .enumerator
                    .as_ref()
                    .unwrap()
                    .GetDefaultAudioEndpoint(eRender, eMultimedia)?
                    .Activate(CLSCTX_ALL, None)?;
                let callback: IAudioEndpointVolumeCallback = VolumeEvents(self.tx.clone()).into();
                volume.RegisterControlChangeNotify(&callback)?;
                self.audio = Some((volume, callback));
            }
            Ok(())
        })();
        // No default render device is a normal unavailable-volume state.
        if result.is_ok() {
            self.read_volume();
        }
    }
    fn read_volume(&mut self) {
        self.snapshot.volume = self.audio.as_ref().and_then(|(v, _)| unsafe {
            Some(Volume {
                percent: (v.GetMasterVolumeLevelScalar().ok()? * 100.0)
                    .round()
                    .clamp(0.0, 100.0) as u8,
                muted: v.GetMute().ok()?.as_bool(),
            })
        });
    }
    fn perform(&mut self, action: Action) -> Result<(), String> {
        self.snapshot.sessions = self.sessions.iter().map(|e| e.data.clone()).collect();
        validate(&self.snapshot, &action)?;
        let result = (|| -> WinResult<()> {
            match action {
                Action::VolumeStep { direction, fine } => {
                    self.read_volume();
                    let v = self
                        .snapshot
                        .volume
                        .as_ref()
                        .ok_or_else(|| Error::new(E_FAIL, "No audio output"))?;
                    let percent = stepped_volume(v.percent, direction, fine);
                    unsafe {
                        self.audio
                            .as_ref()
                            .unwrap()
                            .0
                            .SetMasterVolumeLevelScalar(percent as f32 / 100.0, std::ptr::null())?;
                    }
                }
                Action::Volume { percent } => unsafe {
                    self.audio
                        .as_ref()
                        .unwrap()
                        .0
                        .SetMasterVolumeLevelScalar(percent as f32 / 100.0, std::ptr::null())?;
                },
                Action::Mute { muted } => unsafe {
                    self.audio
                        .as_ref()
                        .unwrap()
                        .0
                        .SetMute(muted, std::ptr::null())?;
                },
                other => {
                    let id = match &other {
                        Action::Toggle { id }
                        | Action::Previous { id }
                        | Action::Next { id }
                        | Action::Seek { id, .. } => id,
                        _ => unreachable!(),
                    };
                    let entry = self
                        .sessions
                        .iter()
                        .find(|e| e.data.id == *id)
                        .ok_or_else(|| Error::new(E_FAIL, "Session closed"))?;
                    let accepted = match other {
                        Action::Toggle { .. } if entry.data.controls.toggle => {
                            wait!(entry.native.TryTogglePlayPauseAsync())?
                        }
                        Action::Toggle { .. } if entry.data.playing => {
                            wait!(entry.native.TryPauseAsync())?
                        }
                        Action::Toggle { .. } => wait!(entry.native.TryPlayAsync())?,
                        Action::Previous { .. } => wait!(entry.native.TrySkipPreviousAsync())?,
                        Action::Next { .. } => wait!(entry.native.TrySkipNextAsync())?,
                        Action::Seek { position_s, .. } => {
                            wait!(entry.native.TryChangePlaybackPositionAsync(
                                entry
                                    .data
                                    .timeline
                                    .as_ref()
                                    .unwrap()
                                    .start_ticks
                                    .saturating_add((position_s * 10_000_000.0) as i64)
                            ))?
                        }
                        _ => unreachable!(),
                    };
                    if !accepted {
                        return Err(Error::new(E_FAIL, "The player declined this control"));
                    }
                }
            }
            Ok(())
        })();
        self.snapshot.error = result.as_ref().err().map(ToString::to_string);
        self.read_volume();
        self.emit();
        result.map_err(|e| e.to_string())
    }
}
fn read_session(entry: &mut Entry, metadata: bool) -> WinResult<()> {
    if metadata {
        let properties = wait!(entry.native.TryGetMediaPropertiesAsync())?;
        entry.data.title = properties.Title()?.to_string().chars().take(512).collect();
        entry.data.artist = properties.Artist()?.to_string().chars().take(512).collect();
        // Cached per session until the next metadata event. Playback/timeline never reopen the stream.
        entry.data.art = (|| -> WinResult<Option<String>> {
            let stream = wait!(properties.Thumbnail()?.OpenReadAsync())?;
            let size = stream.Size()?;
            if size == 0 || size > 4 * 1024 * 1024 {
                return Ok(None);
            }
            let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
            let loaded = wait!(reader.LoadAsync(size as u32))?;
            if loaded != size as u32 {
                return Ok(None);
            }
            let mut bytes = vec![0; loaded as usize];
            reader.ReadBytes(&mut bytes)?;
            let art = thumbnail(&bytes);
            let _ = reader.Close();
            let _ = stream.Close();
            Ok(art)
        })()
        .ok()
        .flatten();
    }
    let playback = entry.native.GetPlaybackInfo()?;
    let controls = playback.Controls()?;
    entry.data.playing = playback.PlaybackStatus()? == Status::Playing;
    entry.data.controls = Controls {
        play: controls.IsPlayEnabled()?,
        pause: controls.IsPauseEnabled()?,
        toggle: controls.IsPlayPauseToggleEnabled()?,
        previous: controls.IsPreviousEnabled()?,
        next: controls.IsNextEnabled()?,
        seek: controls.IsPlaybackPositionEnabled()?,
    };
    entry.data.timeline = entry.native.GetTimelineProperties().ok().and_then(|t| {
        let start = t.StartTime().ok()?.Duration;
        let end = t.EndTime().ok()?.Duration;
        if end <= start {
            return None;
        }
        let duration = end.checked_sub(start)? as f64 / 10_000_000.0;
        Some(Timeline {
            position_s: (t.Position().ok()?.Duration.checked_sub(start)? as f64 / 10_000_000.0)
                .clamp(0.0, duration),
            duration_s: duration,
            updated_at_ms: t.LastUpdatedTime().ok()?.UniversalTime / 10_000 - 11_644_473_600_000,
            rate: playback
                .PlaybackRate()
                .and_then(|r| r.Value())
                .unwrap_or(1.0),
            start_ticks: start,
        })
    });
    Ok(())
}
#[implement(IAudioEndpointVolumeCallback)]
struct VolumeEvents(mpsc::Sender<Notice>);
impl IAudioEndpointVolumeCallback_Impl for VolumeEvents_Impl {
    fn OnNotify(&self, _: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> WinResult<()> {
        let _ = self.0.send(Notice::Volume);
        Ok(())
    }
}
#[implement(IMMNotificationClient)]
struct Devices(mpsc::Sender<Notice>);
impl IMMNotificationClient_Impl for Devices_Impl {
    fn OnDeviceStateChanged(&self, _: &PCWSTR, _: DEVICE_STATE) -> WinResult<()> {
        Ok(())
    }
    fn OnDeviceAdded(&self, _: &PCWSTR) -> WinResult<()> {
        Ok(())
    }
    fn OnDeviceRemoved(&self, _: &PCWSTR) -> WinResult<()> {
        Ok(())
    }
    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _: &PCWSTR) -> WinResult<()> {
        if flow == eRender && role == eMultimedia {
            let _ = self.0.send(Notice::Endpoint);
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _: &PCWSTR, _: &PROPERTYKEY) -> WinResult<()> {
        Ok(())
    }
}
