use tauri::image::Image;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
