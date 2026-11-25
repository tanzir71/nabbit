//! Cached Direct2D surfaces and compositor-owned geometry/opacity animation.
//! No render timer, HWND resize, JavaScript or per-frame surface redraw.
use crate::island_native_model::{Fade, Geometry, Motion, Surface};
use std::time::Instant;
use windows::{
    core::{w, Interface, Result},
    Win32::{
        Foundation::{HMODULE, HWND, POINT},
        Graphics::{
            Direct2D::{Common::*, *},
            Direct3D::*,
            Direct3D11::*,
            DirectComposition::*,
            DirectWrite::*,
            Dxgi::{Common::*, IDXGIDevice},
        },
        UI::Shell::SHCreateMemStream,
    },
};
use windows_numerics::{Matrix3x2, Vector2, Vector4};

pub struct Renderer {
    d3d: ID3D11Device,
    device: IDCompositionDevice3,
    _target: IDCompositionTarget,
    pill: IDCompositionVisual2,
    clip: IDCompositionRectangleClip,
    shadow_shape: IDCompositionVisual2,
    shadow_clip: IDCompositionRectangleClip,
    live: IDCompositionVisual2,
    visibility: IDCompositionEffectGroup,
    live_opacity: IDCompositionEffectGroup,
    live_surface: Option<IDCompositionSurface>,
    fonts: Option<super::native_fonts::Fonts>,
    fade: Fade,
    fade_began: Instant,
    scale: f32,
    pub warp: bool,
    pub commits: u64,
    pub surface_draws: u64,
}

impl Renderer {
    pub fn new(hwnd: isize, scale: f32) -> Result<Self> {
        unsafe {
            macro_rules! stage {
                ($name:literal,$value:expr) => {
                    $value.map_err(|error: windows::core::Error| {
                        windows::core::Error::new(error.code(), concat!("Native graphics: ", $name))
                    })?
                };
            }
            let mut d3d = None;
            let hardware = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut d3d),
                None,
                None,
            );
            let warp = hardware.is_err();
            if warp {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_WARP,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut d3d),
                    None,
                    None,
                )?;
            }
            let d3d = d3d.expect("successful device creation");
            let dxgi: IDXGIDevice = stage!("DXGI interface", d3d.cast());
            let factory: ID2D1Factory1 = stage!(
                "D2D factory",
                D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)
            );
            let d2d = stage!("D2D device", factory.CreateDevice(&dxgi));
            let desktop: IDCompositionDesktopDevice = stage!(
                "composition desktop device",
                DCompositionCreateDevice3(&d2d)
            );
            let device: IDCompositionDevice3 =
                stage!("composition effect interface", desktop.cast());
            let target = stage!(
                "HWND target",
                desktop.CreateTargetForHwnd(HWND(hwnd as *mut _), true)
            );
            let scene = device.CreateVisual()?;
            scene.SetBorderMode(DCOMPOSITION_BORDER_MODE_SOFT)?;
            scene.SetBitmapInterpolationMode(DCOMPOSITION_BITMAP_INTERPOLATION_MODE_LINEAR)?;
            let visibility = device.CreateEffectGroup()?;
            visibility.SetOpacity2(1.0)?;
            scene.SetEffect(&visibility)?;
            let pixel = device.CreateSurface(
                1,
                1,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_ALPHA_MODE_PREMULTIPLIED,
            )?;
            let mut offset = POINT::default();
            let dc: ID2D1DeviceContext =
                stage!("D2D surface context", pixel.BeginDraw(None, &mut offset));
            dc.Clear(Some(&D2D1_COLOR_F {
                r: 5.0 / 255.0,
                g: 5.0 / 255.0,
                b: 6.0 / 255.0,
                a: 1.0,
            }));
            pixel.EndDraw()?;

            let fill = || -> Result<IDCompositionVisual2> {
                let visual = device.CreateVisual()?;
                visual.SetContent(&pixel)?;
                let transform = device.CreateScaleTransform()?;
                transform.SetScaleX2(720.0 * scale)?;
                transform.SetScaleY2(460.0 * scale)?;
                visual.SetTransform(&transform)?;
                Ok(visual)
            };
            let shadow_container = device.CreateVisual()?;
            let shadow = device.CreateShadowEffect()?;
            shadow.SetStandardDeviation2(15.0 * scale)?;
            shadow.SetColor(&Vector4 {
                X: 0.0,
                Y: 0.0,
                Z: 0.0,
                W: 0.32,
            })?;
            shadow_container.SetEffect(&shadow)?;
            let shadow_shape = device.CreateVisual()?;
            let shadow_clip = device.CreateRectangleClip()?;
            shadow_clip.SetLeft2(0.0)?;
            shadow_clip.SetTop2(0.0)?;
            shadow_shape.SetClip(&shadow_clip)?;
            shadow_shape.SetOffsetY2(22.0 * scale)?;
            shadow_shape.AddVisual(&fill()?, false, None)?;
            shadow_container.AddVisual(&shadow_shape, false, None)?;
            scene.AddVisual(&shadow_container, false, None)?;

            let pill = device.CreateVisual()?;
            let clip = device.CreateRectangleClip()?;
            clip.SetLeft2(0.0)?;
            clip.SetTop2(0.0)?;
            pill.SetClip(&clip)?;
            pill.SetOffsetY2(6.0 * scale)?;
            pill.AddVisual(&fill()?, false, None)?;
            let live = device.CreateVisual()?;
            let live_opacity = device.CreateEffectGroup()?;
            live_opacity.SetOpacity2(0.0)?;
            live.SetEffect(&live_opacity)?;
            // With a NULL reference, FALSE inserts above every sibling.
            pill.AddVisual(&live, false, None)?;
            scene.AddVisual(&pill, false, None)?;
            target.SetRoot(&scene)?;
            let mut result = Self {
                d3d,
                device,
                _target: target,
                pill,
                clip,
                shadow_shape,
                shadow_clip,
                live,
                visibility,
                live_opacity,
                live_surface: None,
                fonts: None,
                fade: Fade::new(0.0, Surface::Idle, false, false),
                fade_began: Instant::now(),
                scale,
                warp,
                commits: 0,
                surface_draws: 1,
            };
            result.geometry_immediate(Surface::Idle.geometry())?;
            result.commit()?;
            Ok(result)
        }
    }

    fn commit(&mut self) -> Result<()> {
        unsafe {
            self.device.Commit()?;
            self.device.WaitForCommitCompletion()?;
        }
        self.commits += 1;
        Ok(())
    }
    pub fn visible(&mut self, visible: bool) -> Result<()> {
        unsafe {
            self.visibility
                .SetOpacity2(if visible { 1.0 } else { 0.0 })?;
        }
        self.commit()
    }
    pub fn show_state(
        &mut self,
        motion: Motion,
        state: Surface,
        animate: bool,
        reduced: bool,
    ) -> Result<()> {
        unsafe {
            if state == Surface::Live {
                self.prepare_live()?;
            }
            if animate && motion.duration > 0.0 {
                let animation = |a: f32, b: f32| self.animation(motion, a, b);
                self.pill.SetOffsetX(&animation(
                    motion.from.x() * self.scale,
                    motion.to.x() * self.scale,
                )?)?;
                self.clip.SetRight(&animation(
                    motion.from.width * self.scale,
                    motion.to.width * self.scale,
                )?)?;
                self.clip.SetBottom(&animation(
                    motion.from.height * self.scale,
                    motion.to.height * self.scale,
                )?)?;
                let radius = animation(
                    motion.from.radius * self.scale,
                    motion.to.radius * self.scale,
                )?;
                set_radius_animation(&self.clip, &radius)?;
                self.shadow_shape.SetOffsetX(&animation(
                    (motion.from.x() + 6.0) * self.scale,
                    (motion.to.x() + 6.0) * self.scale,
                )?)?;
                self.shadow_clip.SetRight(&animation(
                    (motion.from.width - 12.0) * self.scale,
                    (motion.to.width - 12.0) * self.scale,
                )?)?;
                self.shadow_clip.SetBottom(&animation(
                    (motion.from.height - 12.0) * self.scale,
                    (motion.to.height - 12.0) * self.scale,
                )?)?;
                set_radius_animation(
                    &self.shadow_clip,
                    &animation(
                        (motion.from.radius - 6.0) * self.scale,
                        (motion.to.radius - 6.0) * self.scale,
                    )?,
                )?;
            } else {
                self.geometry_immediate(motion.to)?;
            }
            if animate {
                let opacity = self.device.CreateAnimation()?;
                let fade = Fade::new(
                    self.fade.value(self.fade_began.elapsed().as_secs_f64()),
                    state,
                    reduced,
                    true,
                );
                if fade.delay > 0.0 {
                    opacity.AddCubic(0.0, fade.from, 0.0, 0.0, 0.0)?;
                }
                opacity.AddCubic(
                    fade.delay,
                    fade.from,
                    (fade.to - fade.from) / fade.duration as f32,
                    0.0,
                    0.0,
                )?;
                opacity.End(fade.delay + fade.duration, fade.to)?;
                self.live_opacity.SetOpacity(&opacity)?;
                self.fade = fade;
            } else {
                self.live_opacity
                    .SetOpacity2(if state == Surface::Live { 1.0 } else { 0.0 })?;
                self.fade = Fade::new(0.0, state, reduced, false);
            }
            self.fade_began = Instant::now();
            self.commit()
        }
    }
    unsafe fn animation(
        &self,
        motion: Motion,
        from: f32,
        to: f32,
    ) -> Result<IDCompositionAnimation> {
        let animation = self.device.CreateAnimation()?;
        if motion.delay > 0.0 {
            animation.AddCubic(0.0, from, 0.0, 0.0, 0.0)?;
        }
        let step = motion.duration / 40.0;
        for index in 0..40 {
            let a = from + (to - from) * motion.stop(index) as f32;
            let b = from + (to - from) * motion.stop(index + 1) as f32;
            animation.AddCubic(
                motion.delay + step * index as f64,
                a,
                (b - a) / step as f32,
                0.0,
                0.0,
            )?;
        }
        animation.End(motion.delay + motion.duration, to)?;
        Ok(animation)
    }
    unsafe fn geometry_immediate(&self, geometry: Geometry) -> Result<()> {
        self.pill.SetOffsetX2(geometry.x() * self.scale)?;
        self.clip.SetRight2(geometry.width * self.scale)?;
        self.clip.SetBottom2(geometry.height * self.scale)?;
        set_radius(&self.clip, geometry.radius * self.scale)?;
        self.shadow_shape
            .SetOffsetX2((geometry.x() + 6.0) * self.scale)?;
        self.shadow_clip
            .SetRight2((geometry.width - 12.0) * self.scale)?;
        self.shadow_clip
            .SetBottom2((geometry.height - 12.0) * self.scale)?;
        set_radius(&self.shadow_clip, (geometry.radius - 6.0) * self.scale)
    }
    unsafe fn prepare_live(&mut self) -> Result<()> {
        if self.live_surface.is_some() {
            return Ok(());
        }
        let surface = self.device.CreateSurface(
            (320.0 * self.scale).round() as u32,
            (32.0 * self.scale).round() as u32,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            DXGI_ALPHA_MODE_PREMULTIPLIED,
        )?;
        let mut offset = POINT::default();
        let dc: ID2D1DeviceContext = surface.BeginDraw(None, &mut offset)?;
        let drawn = (|| -> Result<()> {
            dc.SetDpi(96.0 * self.scale, 96.0 * self.scale);
            dc.Clear(Some(&D2D1_COLOR_F {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 0.0,
            }));
            let x = offset.x as f32 / self.scale;
            let y = offset.y as f32 / self.scale;
            let stream = SHCreateMemStream(Some(include_bytes!("assets/liveRing.svg")))
                .ok_or_else(windows::core::Error::from_thread)?;
            let svg_dc: ID2D1DeviceContext5 = dc.cast()?;
            let svg = svg_dc.CreateSvgDocument(
                &stream,
                D2D_SIZE_F {
                    width: 18.0,
                    height: 18.0,
                },
            )?;
            dc.SetTransform(&translation(x + 10.0, y + 7.0));
            svg_dc.DrawSvgDocument(&svg);
            dc.SetTransform(&translation(x, y));
            dc.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            if self.fonts.is_none() {
                self.fonts = Some(super::native_fonts::Fonts::new()?);
            }
            let fonts = self.fonts.as_ref().expect("initialized bundled fonts");
            let write = &fonts.factory;
            let body = write.CreateTextFormat(
                w!("Geist"),
                fonts.collection(),
                DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                12.0,
                w!("en-us"),
            )?;
            body.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
            body.SetLineSpacing(DWRITE_LINE_SPACING_METHOD_UNIFORM, 16.0, 12.0)?;
            let sign = write.CreateEllipsisTrimmingSign(&body)?;
            body.SetTrimming(
                &DWRITE_TRIMMING {
                    granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                    delimiter: 0,
                    delimiterCount: 0,
                },
                &sign,
            )?;
            let title: Vec<u16> = "Tiny tray app in Rust, full walkthrough"
                .encode_utf16()
                .collect();
            let layout = write.CreateTextLayout(&title, &body, 244.0, 16.0)?;
            let muted = dc.CreateSolidColorBrush(
                &D2D1_COLOR_F {
                    r: 140.0 / 255.0,
                    g: 140.0 / 255.0,
                    b: 146.0 / 255.0,
                    a: 1.0,
                },
                None,
            )?;
            let base: ID2D1RenderTarget = dc.cast()?;
            base.DrawTextLayout(
                Vector2 { X: 36.0, Y: 8.0 },
                &layout,
                &muted,
                D2D1_DRAW_TEXT_OPTIONS_CLIP,
            );
            let mono = write.CreateTextFormat(
                w!("Geist Mono"),
                fonts.collection(),
                DWRITE_FONT_WEIGHT_MEDIUM,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                12.0,
                w!("en-us"),
            )?;
            mono.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_TRAILING)?;
            mono.SetLineSpacing(DWRITE_LINE_SPACING_METHOD_UNIFORM, 16.0, 12.0)?;
            let value: Vec<u16> = "38%".encode_utf16().collect();
            let layout = write.CreateTextLayout(&value, &mono, 32.0, 16.0)?;
            let foreground = dc.CreateSolidColorBrush(
                &D2D1_COLOR_F {
                    r: 245.0 / 255.0,
                    g: 245.0 / 255.0,
                    b: 243.0 / 255.0,
                    a: 1.0,
                },
                None,
            )?;
            base.DrawTextLayout(
                Vector2 { X: 278.0, Y: 8.0 },
                &layout,
                &foreground,
                D2D1_DRAW_TEXT_OPTIONS_CLIP,
            );
            Ok(())
        })();
        let ended = surface.EndDraw();
        drawn?;
        ended?;
        self.live.SetContent(&surface)?;
        self.live_surface = Some(surface);
        self.surface_draws += 1;
        Ok(())
    }
    pub fn frame_clock(&self) -> Result<(i64, i64)> {
        unsafe {
            let stat = self.device.GetFrameStatistics()?;
            Ok((stat.lastFrameTime, stat.timeFrequency))
        }
    }
    pub fn bundled_fonts_loaded(&self) -> bool {
        self.fonts.is_some()
    }
    pub fn capture(
        &self,
        hwnd: isize,
        path: &std::path::Path,
    ) -> Result<super::native_capture::Captured> {
        super::native_capture::capture(hwnd, &self.d3d, path)
    }
}
fn translation(x: f32, y: f32) -> Matrix3x2 {
    Matrix3x2 {
        M11: 1.0,
        M12: 0.0,
        M21: 0.0,
        M22: 1.0,
        M31: x,
        M32: y,
    }
}
unsafe fn set_radius(clip: &IDCompositionRectangleClip, value: f32) -> Result<()> {
    clip.SetTopLeftRadiusX2(value)?;
    clip.SetTopLeftRadiusY2(value)?;
    clip.SetTopRightRadiusX2(value)?;
    clip.SetTopRightRadiusY2(value)?;
    clip.SetBottomLeftRadiusX2(value)?;
    clip.SetBottomLeftRadiusY2(value)?;
    clip.SetBottomRightRadiusX2(value)?;
    clip.SetBottomRightRadiusY2(value)
}
unsafe fn set_radius_animation(
    clip: &IDCompositionRectangleClip,
    value: &IDCompositionAnimation,
) -> Result<()> {
    clip.SetTopLeftRadiusX(value)?;
    clip.SetTopLeftRadiusY(value)?;
    clip.SetTopRightRadiusX(value)?;
    clip.SetTopRightRadiusY(value)?;
    clip.SetBottomLeftRadiusX(value)?;
    clip.SetBottomLeftRadiusY(value)?;
    clip.SetBottomRightRadiusX(value)?;
    clip.SetBottomRightRadiusY(value)
}
