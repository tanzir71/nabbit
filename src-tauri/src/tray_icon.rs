use tauri::image::Image;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskbarTheme {
    Light,
    Dark,
}

impl TaskbarTheme {
    #[cfg(any(windows, test))]
    pub fn from_system_light(value: Option<u32>) -> Self {
        match value {
            Some(1) => Self::Light,
            // Windows 10's taskbar defaults to dark, including before 1903.
            _ => Self::Dark,
        }
    }
}

pub fn image(theme: TaskbarTheme, physical_size: u32) -> tauri::Result<Image<'static>> {
    let png: &[u8] = if physical_size <= 16 {
        include_bytes!("../icons/tray-16.png")
    } else {
        include_bytes!("../icons/tray-24.png")
    };
    let source = Image::from_bytes(png)?;
    let mut rgba = source.rgba().to_vec();
    let colour = match theme {
        TaskbarTheme::Light => [23, 23, 26],
        TaskbarTheme::Dark => [255, 255, 255],
    };
    // Use the original alpha as a mask. Explicit tint also avoids RGB rounding
    // from premultiplied SVG rasterization at partially transparent edge pixels.
    for pixel in rgba.chunks_exact_mut(4) {
        pixel[..3].copy_from_slice(&colour);
    }
    Ok(Image::new_owned(rgba, source.width(), source.height()))
}

pub fn badged(
    theme: TaskbarTheme,
    physical_size: u32,
    badge: crate::modes::model::Badge,
) -> tauri::Result<Image<'static>> {
    use crate::modes::model::Badge;
    let source = image(theme, physical_size)?;
    if badge == Badge::None {
        return Ok(source);
    }
    let mut rgba = source.rgba().to_vec();
    let size = source.width();
    let margin = if size <= 16 { 2 } else { 3 };
    let height = if size <= 16 { 2 } else { 3 };
    let width = size - 2 * margin;
    let colour = match theme {
        TaskbarTheme::Light => [23, 23, 26],
        TaskbarTheme::Dark => [255, 255, 255],
    };
    // The progress mark occupies the transparent space below the original
    // optical capsule. Never redraw, resize or cover the source glyph.
    for y in size - height..size {
        for x in margin..size - margin {
            let alpha = match badge {
                Badge::Progress(percent) => {
                    if x - margin < (width * u32::from(percent.min(100)) / 100).max(1) {
                        255
                    } else {
                        64
                    }
                }
                Badge::Queued => {
                    if x >= size - margin - height {
                        255
                    } else {
                        0
                    }
                }
                Badge::Paused => {
                    if x == margin + width / 2 - 2 || x == margin + width / 2 + 1 {
                        255
                    } else {
                        0
                    }
                }
                Badge::None => 0,
            };
            let index = ((y * size + x) * 4) as usize;
            rgba[index..index + 3].copy_from_slice(&colour);
            rgba[index + 3] = alpha;
        }
    }
    Ok(Image::new_owned(rgba, source.width(), source.height()))
}

pub fn initial_theme() -> TaskbarTheme {
    #[cfg(windows)]
    return crate::taskbar_theme::current();
    #[cfg(not(windows))]
    TaskbarTheme::Light // macOS uses the OS template tint.
}

pub fn physical_size() -> u32 {
    #[cfg(windows)]
    unsafe {
        use windows_sys::{
            core::w,
            Win32::UI::{
                HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
                WindowsAndMessaging::{FindWindowW, SM_CXSMICON},
            },
        };
        let taskbar = FindWindowW(w!("Shell_TrayWnd"), std::ptr::null());
        let dpi = GetDpiForWindow(taskbar).max(96);
        GetSystemMetricsForDpi(SM_CXSMICON, dpi).max(16) as u32
    }
    #[cfg(not(windows))]
    24
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn badges_preserve_optical_glyph_and_progress_is_visible_in_both_taskbar_themes() {
        use crate::modes::model::Badge;
        for size in [16, 24] {
            for theme in [TaskbarTheme::Light, TaskbarTheme::Dark] {
                let base = image(theme, size).unwrap();
                let cutoff = ((size - if size == 16 { 2 } else { 3 }) * size * 4) as usize;
                assert!(base.rgba()[cutoff..]
                    .chunks_exact(4)
                    .all(|pixel| pixel[3] == 0));
                let mut shapes = std::collections::BTreeSet::new();
                for badge in [
                    Badge::None,
                    Badge::Queued,
                    Badge::Paused,
                    Badge::Progress(0),
                    Badge::Progress(50),
                    Badge::Progress(100),
                ] {
                    let icon = badged(theme, size, badge).unwrap();
                    assert_eq!(&icon.rgba()[..cutoff], &base.rgba()[..cutoff]);
                    shapes.insert(icon.rgba().to_vec());
                }
                assert_eq!(shapes.len(), 6);
                let counts = |percent| {
                    badged(theme, size, Badge::Progress(percent))
                        .unwrap()
                        .rgba()[cutoff..]
                        .chunks_exact(4)
                        .filter(|p| p[3] == 255)
                        .count()
                };
                assert!(counts(0) < counts(50) && counts(50) < counts(100));
            }
        }
    }

    #[test]
    fn missing_invalid_and_old_windows_registry_values_default_dark() {
        for value in [None, Some(0), Some(2), Some(u32::MAX)] {
            assert_eq!(TaskbarTheme::from_system_light(value), TaskbarTheme::Dark);
        }
        assert_eq!(
            TaskbarTheme::from_system_light(Some(1)),
            TaskbarTheme::Light
        );
    }

    #[test]
    fn optical_glyphs_keep_alpha_and_are_monochrome_in_both_taskbar_themes() {
        for (physical_size, expected) in [(16, 16), (24, 24), (32, 24)] {
            let light = image(TaskbarTheme::Light, physical_size).unwrap();
            let dark = image(TaskbarTheme::Dark, physical_size).unwrap();
            assert_eq!((light.width(), light.height()), (expected, expected));
            assert_eq!(light.rgba().len(), dark.rgba().len());
            let mut visible = 0;
            for (ink, white) in light
                .rgba()
                .chunks_exact(4)
                .zip(dark.rgba().chunks_exact(4))
            {
                assert_eq!(ink[3], white[3]);
                assert_eq!(&white[..3], &[255, 255, 255]);
                if ink[3] > 0 {
                    visible += 1;
                    assert_eq!(&ink[..3], &[23, 23, 26]);
                }
            }
            assert!(visible > 0);
            assert_eq!(light.rgba()[3], 0);
        }
    }
}
