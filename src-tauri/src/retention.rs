use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

use crate::db::Database;

pub fn spawn_retention_gc(db: Database, shutdown: Arc<AtomicBool>) {
    thread::Builder::new()
        .name("nabbit-retention-gc".into())
        .spawn(move || {
            let _ = db.run_retention_gc();
            while !shutdown.load(Ordering::Relaxed) {
                for _ in 0..(60 * 60 * 3) {
                    if shutdown.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
                if let Err(error) = db.run_retention_gc() {
                    eprintln!("retention GC error: {error}");
                }
            }
        })
        .expect("spawn retention worker");
}
