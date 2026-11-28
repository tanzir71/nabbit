//! Explorer commands are argv, never a shell script. One batch lands on Shelf;
//! selecting a preset requests review and does not start a transformation.
use crate::{
    error::{msg, Result},
    tools::registry,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path, time::Duration};
use tauri::{Emitter, Manager};
pub const BATCH_WINDOW: Duration = Duration::from_millis(300);
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    #[default]
    Shelf,
    Tool {
        #[serde(rename = "toolId")]
        tool_id: String,
        #[serde(rename = "presetId")]
        preset_id: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Invocation {
    pub target: Target,
    pub paths: Vec<String>,
}
pub fn parse(args: &[String], cwd: &Path) -> Result<Option<Invocation>> {
    if !args.iter().skip(1).any(|arg| arg == "--send-to") {
        return Ok(None);
    }
    let mut tool = None;
    let mut preset = None;
    let mut paths = Vec::new();
    let mut index = 1;
    let mut payload = false;
    while index < args.len() {
        let arg = &args[index];
        if payload {
            if arg.len() > 32760 || arg.contains(['\0', '\n', '\r']) {
                return Err(msg("Unsupported incoming path"));
            }
            let path = Path::new(arg);
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                cwd.join(path)
            };
            if !path.is_absolute() {
                return Err(msg("Incoming paths need an absolute working directory"));
            }
            paths.push(path.to_string_lossy().into_owned());
        } else {
            match arg.as_str() {
                "--send-to" => {}
                "--" => payload = true,
                "--tool" | "--preset" => {
                    index += 1;
                    let value = args
                        .get(index)
                        .ok_or_else(|| msg("Missing incoming preset option"))?
                        .clone();
                    let slot = if arg == "--tool" {
                        &mut tool
                    } else {
                        &mut preset
                    };
                    if slot.replace(value).is_some() {
                        return Err(msg("Duplicate incoming preset option"));
                    }
                }
                _ => return Err(msg("Unsupported incoming argument")),
            }
        }
        index += 1;
    }
    if paths.is_empty() || paths.len() > 256 {
        return Err(msg("Send between 1 and 256 files"));
    }
    let target = match (tool, preset) {
        (None, None) => Target::Shelf,
        (Some(tool_id), Some(preset_id)) => {
            let tool = registry::get(&tool_id)?;
            if !tool.presets.contains(&preset_id.as_str()) {
                return Err(msg("This preset does not belong to the tool"));
            }
            Target::Tool { tool_id, preset_id }
        }
        _ => return Err(msg("Choose both a tool and its preset")),
    };
    Ok(Some(Invocation { target, paths }))
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub paths: Vec<String>,
    pub reviews: Vec<Invocation>,
}
pub fn combine(invocations: Vec<Invocation>) -> Result<Batch> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    let mut reviews: Vec<Invocation> = Vec::new();
    for invocation in invocations {
        for path in &invocation.paths {
            let key = if cfg!(windows) {
                path.to_lowercase()
            } else {
                path.clone()
            };
            if seen.insert(key) {
                paths.push(path.clone());
            }
        }
        if invocation.target != Target::Shelf {
            if let Some(existing) = reviews.iter_mut().find(|r| r.target == invocation.target) {
                for path in invocation.paths {
                    if !existing.paths.contains(&path) {
                        existing.paths.push(path);
                    }
                }
            } else {
                reviews.push(invocation);
            }
        }
    }
    if paths.is_empty() || paths.len() > 256 {
        return Err(msg("A Shelf batch supports up to 256 files"));
    }
    Ok(Batch {
        id: uuid::Uuid::new_v4().to_string(),
        paths,
        reviews,
    })
}
fn fail(app: &tauri::AppHandle, error: String) {
    if let Ok(mut state) = app.state::<super::Service>().batch_error.lock() {
        *state = Some(error);
    }
    let _ = app.emit("context:batch", ());
}
pub fn intake(app: &tauri::AppHandle, args: &[String], cwd: &Path) -> bool {
    match parse(args, cwd) {
        Ok(None) => false,
        Err(error) => {
            fail(app, error.to_string());
            true
        }
        Ok(Some(invocation)) => {
            let service = app.state::<super::Service>();
            if let Err(error) = enqueue(&service, invocation) {
                fail(app, error.to_string());
            }
            true
        }
    }
}
fn enqueue(service: &super::Service, invocation: Invocation) -> Result<()> {
    // Keep the sender lock until a cold invocation has entered pending. Startup
    // takes these locks in the same order, so nothing can land after its drain.
    let incoming = service
        .incoming
        .lock()
        .map_err(|_| msg("Explorer intake is unavailable"))?;
    if let Some(sender) = incoming.as_ref() {
        return sender
            .send(invocation)
            .map_err(|_| msg("Explorer intake stopped"));
    }
    let mut pending = service
        .pending
        .lock()
        .map_err(|_| msg("Explorer intake is unavailable"))?;
    if pending.len() >= 256 {
        return Err(msg("Too many incoming batches"));
    }
    pending.push(invocation);
    drop(pending);
    drop(incoming);
    Ok(())
}
fn install_sender(service: &super::Service) -> Result<std::sync::mpsc::Receiver<Invocation>> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut incoming = service
        .incoming
        .lock()
        .map_err(|_| msg("Explorer intake is unavailable"))?;
    let mut pending = service
        .pending
        .lock()
        .map_err(|_| msg("Explorer intake is unavailable"))?;
    for invocation in pending.drain(..) {
        sender
            .send(invocation)
            .map_err(|_| msg("Explorer intake stopped"))?;
    }
    *incoming = Some(sender);
    Ok(receiver)
}
pub fn start(app: &tauri::AppHandle) -> Result<()> {
    let service = app.state::<super::Service>();
    let receiver = install_sender(&service)?;
    let events = app.clone();
    std::thread::Builder::new()
        .name("nabbit-explorer-intake".into())
        .spawn(move || {
            while let Ok(first) = receiver.recv() {
                let invocations = match collect(&receiver, first) {
                    Ok(invocations) => invocations,
                    Err(error) => {
                        fail(&events, error.to_string());
                        continue;
                    }
                };
                let result: Result<()> = (|| {
                    let batch = combine(invocations)?;
                    crate::shelf::add(&events.state::<crate::AppState>().db, batch.paths.clone())?;
                    let service = events.state::<super::Service>();
                    *service
                        .batch
                        .lock()
                        .map_err(|_| msg("Explorer batch is unavailable"))? = Some(batch);
                    *service
                        .batch_error
                        .lock()
                        .map_err(|_| msg("Explorer batch is unavailable"))? = None;
                    events.emit("shelf:changed", ())?;
                    events.emit("context:batch", ())?;
                    if super::silent(&events) {
                        return Ok(());
                    }
                    #[cfg(windows)]
                    if let Some(manager) =
                        events.try_state::<std::sync::Arc<crate::island::Manager>>()
                    {
                        if manager
                            .open_context_capture(crate::island::keyboard::Target::Files)
                            .map_err(msg)?
                        {
                            return Ok(());
                        }
                    }
                    crate::show_popover(&events)?;
                    events.emit("context:files-open", ())?;
                    Ok(())
                })();
                if let Err(error) = result {
                    fail(&events, error.to_string());
                }
            }
        })?;
    let args = std::env::args().collect::<Vec<_>>();
    let cwd = std::env::current_dir()?;
    intake(app, &args, &cwd);
    Ok(())
}
fn collect(
    receiver: &std::sync::mpsc::Receiver<Invocation>,
    first: Invocation,
) -> Result<Vec<Invocation>> {
    let deadline = std::time::Instant::now() + BATCH_WINDOW;
    let mut invocations = vec![first];
    let mut overflow = false;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(next) if invocations.len() < 256 => invocations.push(next),
            Ok(_) => overflow = true,
            Err(_) => break,
        }
    }
    if overflow {
        return Err(msg("Too many incoming files; the batch was kept off the Shelf. Send up to 256 files at a time."));
    }
    Ok(invocations)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_handoff_delivers_every_concurrent_invocation_once_and_drains_cold_inputs_first() {
        let service = std::sync::Arc::new(super::super::Service::default());
        let item = |name: String| Invocation {
            target: Target::Shelf,
            paths: vec![name],
        };
        enqueue(&service, item("cold-first".into())).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(9));
        let workers = (0..8)
            .map(|worker| {
                let service = service.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for n in 0..16 {
                        enqueue(&service, item(format!("{worker}-{n}"))).unwrap();
                    }
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let receiver = install_sender(&service).unwrap();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(2)).unwrap().paths,
            ["cold-first"]
        );
        let mut seen = HashSet::new();
        for _ in 0..128 {
            let invocation = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(seen.insert(invocation.paths[0].clone()));
        }
        assert!(receiver.try_recv().is_err());
        assert!(service.pending.lock().unwrap().is_empty());
    }
    #[test]
    fn the_fixed_300ms_window_collects_a_burst_once_and_keeps_a_later_invocation_for_the_next_batch(
    ) {
        let (sender, receiver) = std::sync::mpsc::channel();
        let invocation = |n| Invocation {
            target: Target::Shelf,
            paths: vec![format!("fixture-{n}.png")],
        };
        sender.send(invocation(0)).unwrap();
        let producer = std::thread::spawn(move || {
            for n in 1..4 {
                std::thread::sleep(Duration::from_millis(20));
                sender.send(invocation(n)).unwrap();
            }
            std::thread::sleep(Duration::from_millis(380));
            sender.send(invocation(4)).unwrap();
        });
        let first = receiver.recv().unwrap();
        let start = std::time::Instant::now();
        let batch = combine(collect(&receiver, first).unwrap()).unwrap();
        assert!(start.elapsed() >= BATCH_WINDOW);
        assert_eq!(
            batch.paths,
            (0..4)
                .map(|n| format!("fixture-{n}.png"))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(2)).unwrap().paths,
            ["fixture-4.png"]
        );
        producer.join().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        for n in 0..258 {
            sender.send(invocation(n)).unwrap();
        }
        drop(sender);
        assert!(collect(&receiver, receiver.recv().unwrap()).is_err());
    }
    #[test]
    fn parser_keeps_unicode_spaces_and_switch_looking_names_after_the_separator() {
        let root = std::env::temp_dir();
        let args = vec![
            "nabbit.exe",
            "--send-to",
            "--tool",
            "to-jpg",
            "--preset",
            "jpg",
            "--",
            "বাংলা photo.png",
            "--not-a-switch.png",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        let invocation = parse(&args, &root).unwrap().unwrap();
        assert_eq!(invocation.paths.len(), 2);
        assert!(invocation.paths[0].ends_with("বাংলা photo.png"));
        assert!(matches!(invocation.target, Target::Tool { .. }));
        assert!(
            parse(&["app".into(), "nabbit://nab?url=fixture".into()], &root)
                .unwrap()
                .is_none()
        );
        for tail in [
            vec!["--tool", "no-tool", "--preset", "jpg", "--", "a"],
            vec!["--tool", "to-jpg", "--preset", "discord", "--", "a"],
            vec!["--tool", "to-jpg", "--", "a"],
            vec!["--unknown", "--", "a"],
            vec!["--"],
        ] {
            let mut args = vec!["app".into(), "--send-to".into()];
            args.extend(tail.into_iter().map(String::from));
            assert!(parse(&args, &root).is_err());
        }
    }
    #[test]
    fn n_invocations_become_one_ordered_shelf_batch_with_separate_review_intents() {
        let root = std::env::temp_dir();
        let paths = (0..7)
            .map(|i| root.join(format!("{i}.png")).to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let target = Target::Tool {
            tool_id: "to-jpg".into(),
            preset_id: "jpg".into(),
        };
        let mut invocations = paths
            .iter()
            .map(|p| Invocation {
                target: target.clone(),
                paths: vec![p.clone()],
            })
            .collect::<Vec<_>>();
        invocations.push(Invocation {
            target: Target::Shelf,
            paths: vec![paths[0].clone()],
        });
        let batch = combine(invocations).unwrap();
        assert_eq!(batch.paths, paths);
        assert_eq!(batch.reviews.len(), 1);
        assert_eq!(batch.reviews[0].paths.len(), 7);
        assert_eq!(BATCH_WINDOW.as_millis(), 300);
        assert!(combine(vec![]).is_err());
    }
}
