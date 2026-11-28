use crate::{
    download::engine::process::Tree,
    error::{msg, Result},
};
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
pub fn run(
    ffmpeg: &Path,
    args: &[String],
    seconds: f64,
    cancel: &AtomicBool,
    progress: &dyn Fn(f64),
    timeout: Duration,
) -> Result<()> {
    let mut command = Command::new(ffmpeg);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let tree = match Tree::attach(&child) {
        Ok(t) => t,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    progress(0.);
    let ticks = Arc::new(AtomicU64::new(0));
    let reader_ticks = ticks.clone();
    let mut stdout = child.stdout.take().expect("piped stdout");
    let out = std::thread::spawn(move || {
        let mut buf = [0; 1024];
        let mut line = Vec::new();
        while let Ok(n) = stdout.read(&mut buf) {
            if n == 0 {
                break;
            }
            for &b in &buf[..n] {
                if b == b'\n' {
                    if let Ok(line) = std::str::from_utf8(&line) {
                        if let Some(n) = line
                            .strip_prefix("out_time_us=")
                            .and_then(|n| n.trim().parse::<u64>().ok())
                        {
                            reader_ticks.store(n, Ordering::Release);
                        }
                    }
                    line.clear();
                } else if line.len() < 256 {
                    line.push(b);
                }
            }
        }
    });
    let stderr = child.stderr.take().expect("piped stderr");
    let err = std::thread::spawn(move || {
        let mut data = Vec::new();
        let mut pipe = stderr;
        let mut buf = [0; 4096];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            let keep = n.min(65536usize.saturating_sub(data.len()));
            data.extend_from_slice(&buf[..keep]);
        }
        String::from_utf8_lossy(&data).into_owned()
    });
    let start = Instant::now();
    let mut last = Instant::now();
    let result = loop {
        if cancel.load(Ordering::Acquire) || start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break Err(msg(if cancel.load(Ordering::Acquire) {
                "Cancelled"
            } else {
                "The tool exceeded its time limit"
            }));
        }
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s.success()),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.into());
            }
        }
        if last.elapsed() >= Duration::from_millis(500) {
            progress(
                (ticks.load(Ordering::Acquire) as f64 / 1_000_000. / seconds * 100.).clamp(0., 99.),
            );
            last = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    drop(tree);
    let _ = out.join();
    let error = err.join().unwrap_or_default();
    if !result? {
        return Err(msg(format!(
            "The media operation could not finish: {}",
            error.trim()
        )));
    }
    let observed = ticks.load(Ordering::Acquire);
    if observed > 0 {
        progress((observed as f64 / 1_000_000. / seconds * 100.).clamp(0., 99.));
    }
    Ok(())
}
