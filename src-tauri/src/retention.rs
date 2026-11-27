use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use crate::db::Database;
use tauri::Emitter;

pub fn spawn_retention_gc(app: tauri::AppHandle, db: Database, shutdown: Arc<AtomicBool>) {
    thread::Builder::new()
        .name("nabbit-retention-gc".into())
        .spawn(move || {
            if db.run_retention_gc().is_ok_and(|count| count > 0) {
                let _ = app.emit("clipboard:changed", ());
            }
            while !shutdown.load(Ordering::Relaxed) {
                for _ in 0..(60 * 60 * 3) {
                    if shutdown.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
                match db.run_retention_gc() {
                    Ok(count) if count > 0 => {
                        let _ = app.emit("clipboard:changed", ());
                    }
                    Err(error) => eprintln!("retention GC error: {error}"),
                    _ => {}
                }
            }
        })
        .expect("spawn retention worker");
}
