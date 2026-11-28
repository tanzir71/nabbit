use super::*;
use crate::db::Database;
use std::{path::PathBuf, sync::atomic::Ordering};
struct Work(PathBuf);
impl Drop for Work {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn output_args(args: &mut Vec<String>, output: &Path) {
    args.extend([
        "-progress".into(),
        "pipe:1".into(),
        "-stats_period".into(),
        "0.5".into(),
        output.to_string_lossy().into(),
    ]);
}
fn run(
    ffmpeg: &Path,
    args: &[String],
    seconds: f64,
    cancel: &AtomicBool,
    progress: &dyn Fn(f64),
) -> Result<()> {
    super::super::process::run(
        ffmpeg,
        args,
        seconds,
        cancel,
        progress,
        Duration::from_secs(86400),
    )
}
fn video_args(args: &mut Vec<String>, encoder: &str, plan: &Plan) {
    args.extend([
        "-map".into(),
        "0:V:0".into(),
        "-c:v".into(),
        encoder.into(),
        "-b:v".into(),
        format!("{}k", plan.video_kbps),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-vf".into(),
        format!(
            "scale={}:{}:flags=lanczos,setsar=1",
            plan.width, plan.height
        ),
    ]);
    if encoder == "libx264" {
        args.extend(["-preset".into(), "veryfast".into()]);
    }
    if encoder == "h264_mf" {
        args.extend(["-hw_encoding".into(), "1".into()]);
    }
}
fn audio_args(args: &mut Vec<String>, plan: &Plan) {
    if plan.audio_kbps == 0 {
        args.push("-an".into());
    } else {
        args.extend([
            "-map".into(),
            "0:a:0?".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            format!("{}k", plan.audio_kbps),
        ]);
        if plan.mono {
            args.extend(["-ac".into(), "1".into()]);
        }
    }
}
type Progress<'a> = dyn Fn(f64, &str, &Report) + 'a;
pub struct Context<'a> {
    pub ffmpeg: &'a Path,
    pub db: &'a Database,
    pub input: &'a Path,
    pub output: &'a Path,
    pub info: &'a Info,
    pub options: &'a Options,
    pub cancel: &'a AtomicBool,
    pub progress: &'a Progress<'a>,
}
pub fn execute(ctx: Context<'_>, kind: Kind, cap_mb: Option<u32>) -> Result<Report> {
    let Context {
        ffmpeg,
        db,
        input,
        output,
        info,
        options,
        cancel,
        progress,
    } = &ctx;
    let seconds = options.seconds(info)?;
    if matches!(kind, Kind::Fit) {
        return fit(&ctx, cap_mb.ok_or_else(|| msg("Choose a size limit"))?);
    }
    let mut report = Report::default();
    if matches!(kind, Kind::Mp4 | Kind::Trim | Kind::Gif | Kind::Webp) && !info.video {
        return Err(msg("Choose a file with a video stream"));
    }
    if matches!(kind, Kind::Mp3 | Kind::M4a) && !info.audio {
        return Err(msg("This file has no audio stream"));
    }
    if kind == Kind::Trim && options.trim.is_none() {
        return Err(msg("Choose the section to trim"));
    }
    if kind == Kind::Mp4 && options.trim.is_none() {
        let mut args = source_args(input, options);
        args.extend(
            [
                "-map",
                "0:V:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-map_metadata",
                "0",
                "-movflags",
                "+faststart",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        if !options.keep_audio {
            args.push("-an".into());
        }
        output_args(&mut args, output);
        progress(0., "Trying a lossless remux", &report);
        if run(ffmpeg, &args, seconds, cancel, &|p| {
            progress(p * 0.2, "Trying a lossless remux", &report)
        })
        .is_ok()
        {
            report.encoder = "copy".into();
            report.remuxed = true;
            return Ok(report);
        }
        if cancel.load(Ordering::Acquire) {
            return Err(msg("Cancelled"));
        }
    }
    let mut args = source_args(input, options);
    match kind {
        Kind::Mp4 | Kind::Trim => {
            report.encoder = "libx264".into();
            args.extend(
                [
                    "-map",
                    "0:V:0",
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
                    "-b:a",
                    "128k",
                    "-map_metadata",
                    "0",
                    "-movflags",
                    "+faststart",
                ]
                .into_iter()
                .map(str::to_owned),
            );
            if !options.keep_audio {
                args.push("-an".into());
            }
        }
        Kind::Mp3 | Kind::M4a => {
            let codec = if kind == Kind::Mp3 {
                "libmp3lame"
            } else {
                "aac"
            };
            report.encoder = codec.into();
            args.extend([
                "-map".into(),
                "0:a:0".into(),
                "-vn".into(),
                "-c:a".into(),
                codec.into(),
                "-b:a".into(),
                format!(
                    "{}k",
                    options
                        .audio_kbps
                        .unwrap_or(if kind == Kind::Mp3 { 192 } else { 128 })
                ),
                "-map_metadata".into(),
                "0".into(),
            ]);
        }
        Kind::Gif | Kind::Webp => {
            let ratio =
                (f64::from(options.gif_pixels) / f64::from(info.width.max(info.height))).min(1.);
            let w = ((f64::from(info.width) * ratio) as u32 / 2 * 2).max(2);
            let h = ((f64::from(info.height) * ratio) as u32 / 2 * 2).max(2);
            let fps = f64::from(options.gif_fps).min(info.fps.max(1.));
            if kind == Kind::Gif {
                report.encoder = "gif".into();
                // Per-frame palettes keep this single graph streaming instead of
                // buffering an entire long movie while a global palette is built.
                args.extend(["-filter_complex".into(),format!("[0:V:0]fps={fps},scale={w}:{h}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:diff_mode=rectangle[out]"),"-map".into(),"[out]".into(),"-an".into(),"-loop".into(),"0".into()]);
            } else {
                if !gpu::capabilities(ffmpeg, db, false, cancel)?.webp {
                    return Err(msg("The bundled engine has no animated WebP encoder"));
                }
                report.encoder = "libwebp_anim".into();
                args.extend([
                    "-vf".into(),
                    format!("fps={fps},scale={w}:{h}:flags=lanczos"),
                    "-an".into(),
                    "-c:v".into(),
                    "libwebp_anim".into(),
                    "-quality".into(),
                    "80".into(),
                    "-loop".into(),
                    "0".into(),
                ]);
            }
        }
        Kind::Strip => {
            report.encoder = "copy".into();
            args.extend(
                [
                    "-map",
                    "0:v?",
                    "-map",
                    "0:a?",
                    "-map",
                    "0:s?",
                    "-c",
                    "copy",
                    "-map_metadata",
                    "-1",
                    "-map_metadata:s",
                    "-1",
                    "-map_chapters",
                    "-1",
                    "-metadata",
                    "creation_time=",
                    "-metadata",
                    "location=",
                    "-metadata:s",
                    "creation_time=",
                    "-metadata:s",
                    "location=",
                ]
                .into_iter()
                .map(str::to_owned),
            );
        }
        Kind::Fit => unreachable!(),
    }
    output_args(&mut args, output);
    progress(0., "Processing media", &report);
    run(ffmpeg, &args, seconds, cancel, &|p| {
        progress(p, "Processing media", &report)
    })?;
    if kind == Kind::Gif && std::fs::metadata(output)?.len() > 20_000_000 {
        report.warning =
            Some("This GIF is over 20 MB. Trim a shorter section or use animated WebP.".into());
    }
    Ok(report)
}
fn fit(ctx: &Context<'_>, cap: u32) -> Result<Report> {
    let Context {
        ffmpeg,
        db,
        input,
        output,
        info,
        options,
        cancel,
        progress,
    } = ctx;
    let encoder = if !info.video {
        "aac".to_owned()
    } else if options.mode == Mode::Exact {
        "libx264".to_owned()
    } else {
        gpu::capabilities(ffmpeg, db, true, cancel)?
            .selected
            .ok_or_else(|| {
                msg("No GPU encoder passed its test. Choose Exact size to use the CPU.")
            })?
    };
    let work_path = output.with_extension("media-work");
    std::fs::create_dir(&work_path)?;
    let work = Work(work_path);
    fit_using(ctx, cap, &encoder, |plan, number, report, label| {
        if info.video && options.mode == Mode::Exact {
            let log = work.0.join(format!("pass-{number}"));
            let mut pass = source_args(input, options);
            video_args(&mut pass, &encoder, plan);
            pass.extend([
                "-an".into(),
                "-pass:v".into(),
                "1".into(),
                "-passlogfile:v".into(),
                log.to_string_lossy().into(),
                "-f".into(),
                "null".into(),
            ]);
            output_args(&mut pass, Path::new("-"));
            run(ffmpeg, &pass, plan.seconds, cancel, &|p| {
                progress(p * 0.5, &format!("{label} · pass 1 of 2"), report)
            })?;
            let mut pass = source_args(input, options);
            video_args(&mut pass, &encoder, plan);
            audio_args(&mut pass, plan);
            pass.extend([
                "-pass:v".into(),
                "2".into(),
                "-passlogfile:v".into(),
                log.to_string_lossy().into(),
                "-movflags".into(),
                "+faststart".into(),
            ]);
            output_args(&mut pass, output);
            run(ffmpeg, &pass, plan.seconds, cancel, &|p| {
                progress(50. + p * 0.5, &format!("{label} · pass 2 of 2"), report)
            })?;
        } else {
            let mut args = source_args(input, options);
            if info.video {
                video_args(&mut args, &encoder, plan);
            } else {
                args.push("-vn".into());
            }
            audio_args(&mut args, plan);
            args.extend(["-movflags".into(), "+faststart".into()]);
            output_args(&mut args, output);
            run(ffmpeg, &args, plan.seconds, cancel, &|p| {
                progress(p, label, report)
            })?;
        }
        Ok(())
    })
}
fn fit_using(
    ctx: &Context<'_>,
    cap: u32,
    encoder: &str,
    mut encode: impl FnMut(&Plan, u32, &Report, &str) -> Result<()>,
) -> Result<Report> {
    let Context {
        input,
        output,
        info,
        options,
        cancel,
        progress,
        ..
    } = ctx;
    let original = super::super::files::hash_with_cancel(input, Some(cancel))?;
    let mut report = Report {
        encoder: encoder.to_owned(),
        ..Report::default()
    };
    let mut retry = None;
    for number in 1..=3 {
        if cancel.load(Ordering::Acquire) {
            return Err(msg("Cancelled"));
        }
        let source_hash = super::super::files::hash_with_cancel(input, Some(cancel))?;
        if source_hash != original {
            return Err(msg("The original changed before a retry"));
        }
        let plan = plan(info, options, cap, retry)?;
        let label = format!("try {number} of 3");
        progress(0., &label, &report);
        encode(&plan, number, &report, &label)?;
        let bytes = std::fs::metadata(output)?.len();
        let fits = bytes > 0 && bytes <= plan.target_bytes;
        report.attempts.push(Attempt {
            number,
            encoder: encoder.to_owned(),
            plan: plan.clone(),
            bytes,
            source_hash,
            fits,
        });
        progress(99., &label, &report);
        if fits {
            return Ok(report);
        }
        if number < 3 {
            retry = Some(retry_bitrate(&plan, bytes, info.video)?);
        }
    }
    Err(msg("The file still exceeds the limit after three tries. Shorten it or raise the limit; no output was published."))
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    #[test]
    fn retries_reduce_budget_use_original_and_stop_at_three_or_cancel() {
        let root = std::env::temp_dir().join(format!("nabbit-v59-retry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let _owned = Work(root.clone());
        let input = root.join("original.mp4");
        let output = root.join("staging.mp4");
        std::fs::write(&input, b"immutable source bytes").unwrap();
        let db = Database::open(&root).unwrap();
        let info = Info {
            duration_ms: 60000,
            width: 1920,
            height: 1080,
            fps: 30.,
            video: true,
            audio: true,
            channels: 2,
            ..Info::default()
        };
        let options = Options::default();
        let cancel = AtomicBool::new(false);
        let latest = std::cell::RefCell::new(Report::default());
        let progress = |_: f64, _: &str, report: &Report| {
            *latest.borrow_mut() = report.clone();
        };
        let ctx = Context {
            ffmpeg: Path::new("unused"),
            db: &db,
            input: &input,
            output: &output,
            info: &info,
            options: &options,
            cancel: &cancel,
            progress: &progress,
        };
        let original = super::super::super::files::hash(&input).unwrap();
        let run = |last_bytes: u64, cancel_after: bool| {
            let mut budgets = Vec::new();
            let result = fit_using(&ctx, 20, "fake-tested-encoder", |plan, number, _, _| {
                assert_eq!(std::fs::read(&input).unwrap(), b"immutable source bytes");
                budgets.push(plan.video_kbps);
                let file = std::fs::File::create(&output)?;
                file.set_len(if number == 3 { last_bytes } else { 21_000_000 })?;
                if cancel_after {
                    cancel.store(true, Ordering::Release);
                }
                Ok(())
            });
            (result, budgets)
        };
        let (report, budgets) = run(19_500_000, false);
        let report = report.unwrap();
        assert_eq!(report.attempts.len(), 3);
        assert!(budgets.windows(2).all(|b| b[1] < b[0]));
        assert!(report.attempts.iter().all(|a| a.source_hash == original));
        assert!(report.attempts.last().unwrap().fits);
        let (failed, budgets) = run(21_000_000, false);
        assert!(failed.unwrap_err().to_string().contains("three tries"));
        assert_eq!(budgets.len(), 3);
        assert_eq!(latest.borrow().attempts.len(), 3);
        assert!(!latest.borrow().attempts.last().unwrap().fits);
        let (cancelled, budgets) = run(19_500_000, true);
        assert!(cancelled.unwrap_err().to_string().contains("Cancelled"));
        assert_eq!(budgets.len(), 1);
        assert_eq!(super::super::super::files::hash(&input).unwrap(), original);
    }
}
