use super::*;

fn prepared(o: DownloadOptions) -> DownloadOptions {
    o.with_defaults("output with spaces", DEFAULT_TEMPLATE)
        .unwrap()
}
fn assert_args(options: DownloadOptions, expected: &[&str]) {
    let args = build(&prepared(options), None, None, false).unwrap();
    let mut exact = vec![
        "--newline",
        "--no-warnings",
        "--no-cache-dir",
        "--no-overwrites",
        "--progress-template",
        PROGRESS_TEMPLATE,
        "--print",
        "after_move:nabbit-file:%(filepath)s",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();
    exact.extend(expected.iter().map(|s| s.to_string()));
    exact.extend([
        "--no-playlist".into(),
        "-o".into(),
        Path::new("output with spaces")
            .join(DEFAULT_TEMPLATE)
            .to_string_lossy()
            .into_owned(),
    ]);
    assert_eq!(args, exact);
}
#[test]
fn every_video_container_has_the_exact_height_selector_and_merge_flag() {
    for (format, name) in [
        (Format::Mp4, "mp4"),
        (Format::Mkv, "mkv"),
        (Format::Webm, "webm"),
    ] {
        assert_args(
            DownloadOptions {
                format,
                ..Default::default()
            },
            &[
                "-f",
                "bv*[height<=1080]+ba/b[height<=1080]",
                "--merge-output-format",
                name,
            ],
        );
    }
    assert_args(
        DownloadOptions {
            height: None,
            ..Default::default()
        },
        &["-f", "bv*+ba/b", "--merge-output-format", "mp4"],
    );
    assert_args(
        DownloadOptions {
            height: Some(720),
            ..Default::default()
        },
        &[
            "-f",
            "bv*[height<=720]+ba/b[height<=720]",
            "--merge-output-format",
            "mp4",
        ],
    );
}
#[test]
fn all_audio_choices_and_mp3_bitrate_match_the_handoff() {
    assert_args(
        DownloadOptions {
            format: Format::Mp3,
            ..Default::default()
        },
        &["-x", "--audio-format", "mp3", "--audio-quality", "320K"],
    );
    assert_args(
        DownloadOptions {
            format: Format::M4a,
            ..Default::default()
        },
        &["-x", "--audio-format", "m4a"],
    );
    assert_args(
        DownloadOptions {
            format: Format::Opus,
            ..Default::default()
        },
        &["-x", "--audio-format", "opus"],
    );
}
const VIDEO: &[&str] = &[
    "-f",
    "bv*[height<=1080]+ba/b[height<=1080]",
    "--merge-output-format",
    "mp4",
];
fn with<'a>(extra: &[&'a str]) -> Vec<&'a str> {
    VIDEO.iter().copied().chain(extra.iter().copied()).collect()
}
#[test]
fn subtitles_support_embedded_and_sidecar_modes() {
    for embed in [true, false] {
        let mut flags = with(&[
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            "en.*,fr,-live_chat",
        ]);
        if embed {
            flags.push("--embed-subs");
        }
        assert_args(
            DownloadOptions {
                subtitles: Some(Subtitles {
                    languages: vec!["en.*".into(), "fr".into(), "-live_chat".into()],
                    embed,
                }),
                ..Default::default()
            },
            &flags,
        );
    }
}
#[test]
fn chapters_and_sponsorblock_every_mode_have_exact_flags() {
    for (chapters, flags) in [
        (Chapters::Off, vec![]),
        (Chapters::Keep, vec!["--embed-chapters"]),
        (Chapters::Split, vec!["--split-chapters"]),
    ] {
        assert_args(
            DownloadOptions {
                chapters,
                ..Default::default()
            },
            &with(&flags),
        );
    }
    for (sponsor_block, flags) in [
        (SponsorBlock::Off, vec![]),
        (SponsorBlock::Mark, vec!["--sponsorblock-mark", "all"]),
        (SponsorBlock::Cut, vec!["--sponsorblock-remove", "sponsor"]),
    ] {
        assert_args(
            DownloadOptions {
                sponsor_block,
                ..Default::default()
            },
            &with(&flags),
        );
    }
}
#[test]
fn thumbnail_metadata_and_rate_are_opt_in() {
    let o = prepared(DownloadOptions {
        embed_thumbnail: true,
        embed_metadata: true,
        speed_limit: Some("4.2m".into()),
        ..Default::default()
    });
    let args = build(&o, None, None, false).unwrap();
    let mut expected = vec![
        "--newline",
        "--no-warnings",
        "--no-cache-dir",
        "--no-overwrites",
        "--progress-template",
        PROGRESS_TEMPLATE,
        "--print",
        "after_move:nabbit-file:%(filepath)s",
        "-f",
        "bv*[height<=1080]+ba/b[height<=1080]",
        "--merge-output-format",
        "mp4",
        "--embed-thumbnail",
        "--embed-metadata",
        "--no-playlist",
        "-r",
        "4.2M",
        "-o",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    expected.push(
        Path::new("output with spaces")
            .join(DEFAULT_TEMPLATE)
            .to_string_lossy()
            .into_owned(),
    );
    assert_eq!(args, expected);
}
#[test]
fn filename_and_ffmpeg_paths_with_spaces_remain_single_arguments() {
    let o = DownloadOptions {
        filename_template: Some("My videos/%(title)s.%(ext)s".into()),
        output_dir: Some("folder with spaces".into()),
        ..Default::default()
    };
    let args = build(&o, Some(Path::new("engine folder/ffmpeg.exe")), None, false).unwrap();
    assert_eq!(
        &args[12..],
        &[
            "--ffmpeg-location",
            "engine folder/ffmpeg.exe",
            "--no-playlist",
            "-o",
            &Path::new("folder with spaces")
                .join("My videos/%(title)s.%(ext)s")
                .to_string_lossy()
        ]
    );
    assert!(!args.iter().any(|a| a.starts_with('"')));
}
#[test]
fn trim_union_and_precise_cut_use_repeated_sections_without_overwrites() {
    let options = prepared(DownloadOptions {
        sections: vec![
            TimeRange {
                start_ms: 62_500,
                end_ms: 83_125,
            },
            TimeRange {
                start_ms: 0,
                end_ms: 3_000,
            },
        ],
        precise_cuts: true,
        ..Default::default()
    });
    let args = build(&options, None, None, false).unwrap();
    assert_eq!(
        &args[12..18],
        &[
            "--download-sections",
            "*0-3",
            "--download-sections",
            "*62.5-83.125",
            "--force-keyframes-at-cuts",
            "--no-playlist"
        ]
    );
    assert_eq!(
        args.last().unwrap(),
        &Path::new("output with spaces")
            .join("%(section_number)03d - %(title)s [%(id)s].%(ext)s")
            .to_string_lossy()
    );
    let o = DownloadOptions {
        sections: vec![
            TimeRange {
                start_ms: 2_000,
                end_ms: 4_000,
            },
            TimeRange {
                start_ms: 0,
                end_ms: 3_000,
            },
        ],
        ..Default::default()
    }
    .normalized()
    .unwrap();
    assert_eq!(
        o.sections,
        vec![TimeRange {
            start_ms: 0,
            end_ms: 4_000
        }]
    );
}
#[test]
fn playlists_range_and_indices_match_exact_ytdlp_arguments() {
    for (items, expected) in [
        (Some("1–5"), Some("1-5")),
        (Some("1, 3,7"), Some("1,3,7")),
        (None, None),
    ] {
        let args = build(
            &prepared(DownloadOptions {
                playlist_mode: PlaylistMode::Playlist,
                playlist_items: items.map(str::to_owned),
                ..Default::default()
            }),
            None,
            None,
            false,
        )
        .unwrap();
        assert_eq!(args[12], "--yes-playlist");
        if let Some(expected) = expected {
            assert_eq!(&args[13..15], &["-I", expected]);
        } else {
            assert_eq!(args[13], "-o");
        }
        assert!(!args.iter().any(|a| a == "--no-playlist"));
    }
}
#[test]
fn browser_choice_is_job_only_never_an_options_field_or_cookie_file() {
    for (browser, name) in [
        (Browser::Chrome, "chrome"),
        (Browser::Edge, "edge"),
        (Browser::Firefox, "firefox"),
        (Browser::Brave, "brave"),
    ] {
        let o = prepared(Default::default());
        let args = build(&o, None, Some(browser), false).unwrap();
        assert_eq!(&args[13..15], &["--cookies-from-browser", name]);
        assert!(!args.iter().any(|a| a == "--cookies"));
        assert!(!serde_json::to_string(&o).unwrap().contains(name));
    }
    assert!(serde_json::from_str::<DownloadOptions>(r#"{"cookiesFromBrowser":"chrome"}"#).is_err());
}
#[test]
fn fallback_keeps_the_height_cap_instead_of_silently_raising_quality() {
    let args = build(&prepared(Default::default()), None, None, true).unwrap();
    assert_eq!(
        &args[8..12],
        &["-f", "b[height<=1080]", "--merge-output-format", "mp4"]
    );
}
#[test]
fn validation_rejects_bad_ranges_inputs_and_non_finite_rate_without_io() {
    let cases = vec![
        DownloadOptions {
            height: Some(0),
            ..Default::default()
        },
        DownloadOptions {
            speed_limit: Some("0".into()),
            ..Default::default()
        },
        DownloadOptions {
            speed_limit: Some("-1M --exec bad".into()),
            ..Default::default()
        },
        DownloadOptions {
            sections: vec![TimeRange {
                start_ms: 100,
                end_ms: 50,
            }],
            ..Default::default()
        },
        DownloadOptions {
            precise_cuts: true,
            ..Default::default()
        },
        DownloadOptions {
            filename_template: Some("../escape.mp4".into()),
            ..Default::default()
        },
        DownloadOptions {
            filename_template: Some("C:\\escape.mp4".into()),
            ..Default::default()
        },
        DownloadOptions {
            subtitles: Some(Subtitles {
                languages: vec!["en\n--exec".into()],
                embed: false,
            }),
            ..Default::default()
        },
    ];
    for o in cases {
        assert!(o.normalized().is_err(), "{o:?}");
    }
    for items in ["", "0", "-1", "5-1", "1-2-3", "1:5", "1,,3"] {
        assert!(playlist_items(items).is_err(), "{items}");
    }
    for time in ["-1", "1:60", "1:00.0001", "1.2:00", "abc"] {
        assert!(parse_timecode(time).is_err(), "{time}");
    }
}
#[test]
fn timecodes_and_remembered_options_keep_reusable_choices_only() {
    assert_eq!(parse_timecode("1:02.500").unwrap(), 62_500);
    assert_eq!(parse_timecode("01:02:03.1").unwrap(), 3_723_100);
    assert_eq!(parse_timecode("0.01").unwrap(), 10);
    let original = DownloadOptions {
        format: Format::Webm,
        sections: vec![TimeRange {
            start_ms: 0,
            end_ms: 3000,
        }],
        precise_cuts: true,
        playlist_mode: PlaylistMode::Playlist,
        playlist_items: Some("1-5".into()),
        output_dir: Some("job-only-folder".into()),
        sponsor_block: SponsorBlock::Mark,
        ..Default::default()
    };
    let remembered = original.rememberable().unwrap();
    assert!(remembered.sections.is_empty());
    assert!(!remembered.precise_cuts);
    assert_eq!(remembered.playlist_mode, PlaylistMode::Video);
    assert!(remembered.playlist_items.is_none() && remembered.output_dir.is_none());
    assert_eq!(remembered.format, Format::Webm);
    assert_eq!(remembered.sponsor_block, SponsorBlock::Mark);
}

#[test]
#[ignore = "requires the locally provisioned pinned yt-dlp; no media or browser access"]
fn pinned_help_parses_every_generated_mapping_without_network_or_profiles() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let pins: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("scripts/engine-pins.json")).unwrap())
            .unwrap();
    let path =
        crate::download::ytdlp::resolve_engine(&root.join(".tools/v32-empty-app-data"), "yt-dlp")
            .unwrap();
    assert_eq!(
        crate::download::engine::probe_version(&path, "yt-dlp").unwrap(),
        pins["ytdlpVersion"].as_str().unwrap()
    );
    let cases = [
        DownloadOptions::default(),
        DownloadOptions {
            format: Format::Mkv,
            ..Default::default()
        },
        DownloadOptions {
            format: Format::Webm,
            ..Default::default()
        },
        DownloadOptions {
            format: Format::Mp3,
            ..Default::default()
        },
        DownloadOptions {
            format: Format::M4a,
            ..Default::default()
        },
        DownloadOptions {
            format: Format::Opus,
            ..Default::default()
        },
        DownloadOptions {
            subtitles: Some(Subtitles {
                languages: vec!["en.*".into(), "fr".into()],
                embed: true,
            }),
            chapters: Chapters::Keep,
            sponsor_block: SponsorBlock::Mark,
            embed_metadata: true,
            embed_thumbnail: true,
            speed_limit: Some("4.2M".into()),
            ..Default::default()
        },
        DownloadOptions {
            chapters: Chapters::Split,
            sponsor_block: SponsorBlock::Cut,
            sections: vec![
                TimeRange {
                    start_ms: 1000,
                    end_ms: 2000,
                },
                TimeRange {
                    start_ms: 3000,
                    end_ms: 4000,
                },
            ],
            precise_cuts: true,
            playlist_mode: PlaylistMode::Playlist,
            playlist_items: Some("1-5".into()),
            ..Default::default()
        },
    ];
    for (index, options) in cases.iter().enumerate() {
        let mut args = vec!["--ignore-config".into()];
        args.extend(build(&prepared(options.clone()), None, None, false).unwrap());
        args.push("--help".into());
        assert!(!args.iter().any(|a| a == "--cookies-from-browser"));
        let output =
            crate::download::engine::run_bounded(&path, &args, std::time::Duration::from_secs(10))
                .unwrap();
        assert!(output.success, "{}", output.stderr);
        assert!(output.stdout.contains("--download-sections"));
        println!(
            "PINNED_OPTIONS_CASE={}",
            serde_json::json!({"case":index,"args":args,"passed":true})
        );
    }
}
