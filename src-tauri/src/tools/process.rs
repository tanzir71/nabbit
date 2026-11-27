use crate::{
    download::engine::{process::Tree, run_bounded},
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
fn duration(ffmpeg: &Path, input: &Path) -> Result<f64> {
    let result = run_bounded(
        ffmpeg,
        &[
            "-hide_banner".into(),
            "-nostdin".into(),
            "-protocol_whitelist".into(),
            "file,pipe".into(),
            "-format_whitelist".into(),
            "mov,matroska,webm,avi,m4v".into(),
            "-i".into(),
            input.to_string_lossy().into(),
        ],
        Duration::from_secs(20),
    )?;
    let expression = regex::Regex::new(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")
        .expect("constant duration regex");
    let captures = expression
        .captures(&result.stderr)
        .ok_or_else(|| msg("Could not read the video duration"))?;
    let value = |n: usize| captures[n].parse::<f64>().unwrap_or(0.);
    let seconds = value(1) * 3600. + value(2) * 60. + value(3);
    if seconds <= 0. || !seconds.is_finite() {
        return Err(msg("Video duration is unavailable"));
    }
    Ok(seconds)
}
pub fn mp4(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    cancel: &AtomicBool,
    progress: &dyn Fn(f64),
) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        return Err(msg("Cancelled"));
    }
    let seconds = duration(ffmpeg, input)?;
    if cancel.load(Ordering::Acquire) {
        return Err(msg("Cancelled"));
    }
    let args = [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,avi,m4v",
        "-i",
    ]
    .into_iter()
    .map(String::from)
    .chain([input.to_string_lossy().into_owned()])
    .chain(
        [
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-stats_period",
            "0.5",
        ]
        .into_iter()
        .map(String::from),
    )
    .chain([output.to_string_lossy().into_owned()])
    .collect::<Vec<_>>();
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
        if cancel.load(Ordering::Acquire) || start.elapsed() > Duration::from_secs(86400) {
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
        return Err(msg(format!("To MP4 could not finish: {}", error.trim())));
    }
    let observed = ticks.load(Ordering::Acquire);
    if observed > 0 {
        progress((observed as f64 / 1_000_000. / seconds * 100.).clamp(0., 99.));
    }
    Ok(())
}
