//! Static native compact surface selected by the V0 gate. No render timer.
use super::model::{idle_geometry, Placement, Shape};
use super::{
    compact_draw::Painter,
    motion::{Geometry, Motion},
    presentation::Compact,
};
use std::time::Instant;
use windows::{
    core::{Interface, Result},
    Win32::{
        Foundation::{HMODULE, HWND, POINT},
        Graphics::{
            Direct2D::{Common::*, *},
            Direct3D::*,
            Direct3D11::*,
            DirectComposition::*,
            Dxgi::{Common::*, IDXGIDevice},
        },
    },
};
use windows_numerics::Vector4;

pub struct Renderer {
    content: IDCompositionVisual2,
    content_clip: IDCompositionRectangleClip,
    content_opacity: IDCompositionEffectGroup,
    painter: Option<Painter>,
    scene: Option<Compact>,
    motion: Option<Motion>,
    began: Instant,
    native_owner: bool,
    alert_transform: IDCompositionScaleTransform,
    opacity: IDCompositionEffectGroup,
    current_opacity: f64,
    device: IDCompositionDevice3,
    target: IDCompositionTarget,
    pill: IDCompositionVisual2,
    clip: IDCompositionRectangleClip,
    shadow_shape: IDCompositionVisual2,
    shadow_clip: IDCompositionRectangleClip,
    shadow: IDCompositionShadowEffect,
    shadow_opacity: IDCompositionEffectGroup,
    fills: Vec<IDCompositionScaleTransform>,
    d3d: ID3D11Device,
    pub warp: bool,
    pub commits: u64,
}
impl Renderer {
    pub fn new(hwnd: isize, placement: &Placement) -> Result<Self> {
        unsafe {
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
            let d3d = d3d.expect("successful D3D creation");
            let dxgi: IDXGIDevice = d3d.cast()?;
            let factory: ID2D1Factory1 =
                D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let d2d = factory.CreateDevice(&dxgi)?;
            let desktop: IDCompositionDesktopDevice = DCompositionCreateDevice3(&d2d)?;
            let device: IDCompositionDevice3 = desktop.cast()?;
            let target = desktop.CreateTargetForHwnd(HWND(hwnd as *mut _), true)?;
            let scene = device.CreateVisual()?;
            let alert_transform = device.CreateScaleTransform()?;
            alert_transform.SetScaleX2(1.0)?;
            alert_transform.SetScaleY2(1.0)?;
            scene.SetTransform(&alert_transform)?;
            let opacity = device.CreateEffectGroup()?;
            opacity.SetOpacity2(1.0)?;
            scene.SetEffect(&opacity)?;
            scene.SetBorderMode(DCOMPOSITION_BORDER_MODE_SOFT)?;
            let pixel = device.CreateSurface(
                1,
                1,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_ALPHA_MODE_PREMULTIPLIED,
            )?;
            let mut offset = POINT::default();
            let dc: ID2D1DeviceContext = pixel.BeginDraw(None, &mut offset)?;
            dc.Clear(Some(&D2D1_COLOR_F {
                r: 5.0 / 255.0,
                g: 5.0 / 255.0,
                b: 6.0 / 255.0,
                a: 1.0,
            }));
            pixel.EndDraw()?;
            let mut fills = vec![];
            let mut fill = || -> Result<IDCompositionVisual2> {
                let visual = device.CreateVisual()?;
                visual.SetContent(&pixel)?;
                let transform = device.CreateScaleTransform()?;
                visual.SetTransform(&transform)?;
                fills.push(transform);
                Ok(visual)
            };
            let shadow_container = device.CreateVisual()?;
            let shadow = device.CreateShadowEffect()?;
            shadow.SetColor(&Vector4 {
                X: 0.0,
                Y: 0.0,
                Z: 0.0,
                W: 0.32,
            })?;
            let shadow_opacity = device.CreateEffectGroup()?;
            let shadow_root = device.CreateVisual()?;
            shadow_root.SetEffect(&shadow_opacity)?;
            shadow_container.SetEffect(&shadow)?;
            shadow_root.AddVisual(&shadow_container, false, None)?;
            let shadow_shape = device.CreateVisual()?;
            let shadow_clip = device.CreateRectangleClip()?;
            shadow_shape.SetClip(&shadow_clip)?;
            shadow_shape.AddVisual(&fill()?, false, None)?;
            shadow_container.AddVisual(&shadow_shape, false, None)?;
            scene.AddVisual(&shadow_root, false, None)?;
            let pill = device.CreateVisual()?;
            let clip = device.CreateRectangleClip()?;
            pill.SetClip(&clip)?;
            pill.AddVisual(&fill()?, false, None)?;
            scene.AddVisual(&pill, false, None)?;
            let content = device.CreateVisual()?;
            let content_clip = device.CreateRectangleClip()?;
            content.SetClip(&content_clip)?;
            let content_opacity = device.CreateEffectGroup()?;
            content_opacity.SetOpacity2(0.0)?;
            content.SetEffect(&content_opacity)?;
            scene.AddVisual(&content, false, None)?;
            target.SetRoot(&scene)?;
            let mut renderer = Self {
                content,
                content_clip,
                content_opacity,
                painter: None,
                scene: None,
                motion: None,
                began: Instant::now(),
                native_owner: true,
                alert_transform,
                opacity,
                current_opacity: 1.0,
                device,
                target,
                pill,
                clip,
                shadow_shape,
                shadow_clip,
                shadow,
                shadow_opacity,
                fills,
                d3d,
                warp,
                commits: 0,
            };
            renderer.update(placement)?;
            Ok(renderer)
        }
    }
    pub fn update(&mut self, placement: &Placement) -> Result<()> {
        let scene = super::presentation::compact(None, placement.shape);
        let compact_geometry = Geometry::from(&scene);
        self.scene = Some(scene);
        self.motion = Some(Motion::new(compact_geometry, compact_geometry, true));
        self.began = Instant::now();
        let geometry = idle_geometry(placement.shape);
        let scale = placement.render_scale as f32;
        let width = geometry.width as f32 * scale;
        let height = geometry.height as f32 * scale;
        let x = (placement.bounds.width as f32 - width) / 2.0;
        unsafe {
            self.content_opacity.SetOpacity2(0.0)?;
            rectangle(
                &self.content_clip,
                width,
                height,
                geometry.top_radius as f32 * scale,
                geometry.bottom_radius as f32 * scale,
            )?;
            for transform in &self.fills {
                transform.SetScaleX2(placement.bounds.width as f32)?;
                transform.SetScaleY2(placement.bounds.height as f32)?;
            }
            self.pill.SetOffsetX2(x)?;
            self.pill.SetOffsetY2(geometry.top as f32 * scale)?;
            rectangle(
                &self.clip,
                width,
                height,
                geometry.top_radius as f32 * scale,
                geometry.bottom_radius as f32 * scale,
            )?;
            self.shadow_shape.SetOffsetX2(x + 6.0 * scale)?;
            self.shadow_shape.SetOffsetY2(22.0 * scale)?;
            rectangle(
                &self.shadow_clip,
                (width - 12.0 * scale).max(1.0),
                (height - 12.0 * scale).max(1.0),
                7.0 * scale,
                7.0 * scale,
            )?;
            self.shadow.SetStandardDeviation2(15.0 * scale)?;
            self.shadow_opacity
                .SetOpacity2(if placement.shape == Shape::Island {
                    1.0
                } else {
                    0.0
                })?;
            self.device.Commit()?;
        }
        self.commits += 1;
        Ok(())
    }
    pub fn capture(&self, hwnd: isize, path: &std::path::Path) -> Result<super::capture::Captured> {
        super::capture::capture(hwnd, &self.d3d, path)
    }
    pub fn set_opacity(&mut self, value: f64) -> Result<bool> {
        if self.current_opacity == value {
            return Ok(false);
        }
        unsafe {
            let target = if self.native_owner { value as f32 } else { 0.0 };
            if value == 0.35 && self.native_owner {
                let a = self.device.CreateAnimation()?;
                a.AddCubic(
                    0.0,
                    self.current_opacity as f32,
                    (target - self.current_opacity as f32) / 0.2,
                    0.0,
                    0.0,
                )?;
                a.End(0.2, target)?;
                self.opacity.SetOpacity(&a)?;
            } else {
                self.opacity.SetOpacity2(target)?;
            }
            self.device.Commit()?;
        }
        self.current_opacity = value;
        self.commits += 1;
        Ok(true)
    }
    pub fn native_owner(&mut self, visible: bool) -> Result<()> {
        if self.native_owner == visible {
            return Ok(());
        }
        self.native_owner = visible;
        unsafe {
            self.opacity.SetOpacity2(if visible {
                self.current_opacity as f32
            } else {
                0.0
            })?;
            self.device.Commit()?;
        }
        self.commits += 1;
        Ok(())
    }
    pub fn geometry(&self) -> Option<Geometry> {
        self.motion
            .map(|motion| motion.at(self.began.elapsed().as_secs_f64()))
    }
    pub fn compact(
        &mut self,
        placement: &Placement,
        next: &Compact,
        reduced: bool,
    ) -> Result<bool> {
        if self.scene.as_ref() == Some(next) {
            return Ok(false);
        }
        let scale = placement.render_scale as f32;
        let from = self
            .geometry()
            .or_else(|| self.scene.as_ref().map(Geometry::from))
            .unwrap_or_else(|| Geometry::from(next));
        let motion = Motion::new(from, Geometry::from(next), reduced || self.scene.is_none());
        unsafe {
            let bind = |a: f32, b: f32| self.animation(motion, a * scale, b * scale);
            self.pill.SetOffsetX(&bind(from.x(), motion.to.x())?)?;
            self.pill.SetOffsetY(&bind(from.top, motion.to.top)?)?;
            self.content.SetOffsetX(&bind(from.x(), motion.to.x())?)?;
            self.content.SetOffsetY(&bind(from.top, motion.to.top)?)?;
            self.clip
                .SetRight(&bind(from.primary, motion.to.primary)?)?;
            self.clip.SetBottom(&bind(from.height, motion.to.height)?)?;
            self.content_clip
                .SetRight(&bind(from.width, motion.to.width)?)?;
            self.content_clip
                .SetBottom(&bind(from.height, motion.to.height)?)?;
            let top = if next.notch {
                self.device.CreateAnimation()?
            } else {
                bind(from.radius, motion.to.radius)?
            };
            if next.notch {
                top.AddCubic(0.0, 0.0, 0.0, 0.0, 0.0)?;
                top.End(0.0, 0.0)?;
            }
            self.clip.SetTopLeftRadiusX(&top)?;
            self.clip.SetTopLeftRadiusY(&top)?;
            self.clip.SetTopRightRadiusX(&top)?;
            self.clip.SetTopRightRadiusY(&top)?;
            self.content_clip.SetTopLeftRadiusX(&top)?;
            self.content_clip.SetTopLeftRadiusY(&top)?;
            self.content_clip.SetTopRightRadiusX(&top)?;
            self.content_clip.SetTopRightRadiusY(&top)?;
            let radius = bind(from.radius, motion.to.radius)?;
            self.clip.SetBottomLeftRadiusX(&radius)?;
            self.clip.SetBottomLeftRadiusY(&radius)?;
            self.clip.SetBottomRightRadiusX(&radius)?;
            self.clip.SetBottomRightRadiusY(&radius)?;
            self.content_clip.SetBottomLeftRadiusX(&radius)?;
            self.content_clip.SetBottomLeftRadiusY(&radius)?;
            self.content_clip.SetBottomRightRadiusX(&radius)?;
            self.content_clip.SetBottomRightRadiusY(&radius)?;
            self.shadow_shape
                .SetOffsetX(&bind(from.x() + 6.0, motion.to.x() + 6.0)?)?;
            self.shadow_clip.SetRight(&bind(
                (from.primary - 12.0).max(1.0),
                (motion.to.primary - 12.0).max(1.0),
            )?)?;
            self.shadow_clip.SetBottom(&bind(
                (from.height - 12.0).max(1.0),
                (motion.to.height - 12.0).max(1.0),
            )?)?;
            if !next.primary.is_empty() {
                if self.painter.is_none() {
                    self.painter = Some(Painter::new()?);
                }
                let surface = self.painter.as_ref().expect("initialized painter").draw(
                    &self.device,
                    next,
                    scale,
                )?;
                self.content.SetContent(&surface)?;
            }
            let was_live = self
                .scene
                .as_ref()
                .is_some_and(|scene| !scene.primary.is_empty());
            let is_live = !next.primary.is_empty();
            if was_live != is_live {
                let a = self.device.CreateAnimation()?;
                let start = if is_live { 0.0 } else { 1.0 };
                let end = if is_live { 1.0 } else { 0.0 };
                let delay = if is_live && !reduced { 0.06 } else { 0.0 };
                let duration = if reduced || is_live { 0.12 } else { 0.08 };
                if delay > 0.0 {
                    a.AddCubic(0.0, start, 0.0, 0.0, 0.0)?;
                }
                a.AddCubic(delay, start, (end - start) / duration as f32, 0.0, 0.0)?;
                a.End(delay + duration, end)?;
                self.content_opacity.SetOpacity(&a)?;
            } else {
                self.content_opacity
                    .SetOpacity2(if is_live { 1.0 } else { 0.0 })?;
            }
            if next.alert.is_some()
                && next.alert != self.scene.as_ref().and_then(|scene| scene.alert.clone())
                && !reduced
            {
                self.alert_transform.SetCenterX2(360.0 * scale)?;
                self.alert_transform.SetCenterY2(22.0 * scale)?;
                let a = self.device.CreateAnimation()?;
                a.AddCubic(0.0, 1.0, 0.2, 0.0, 0.0)?;
                a.AddCubic(0.2, 1.04, -0.2, 0.0, 0.0)?;
                a.End(0.4, 1.0)?;
                self.alert_transform.SetScaleX(&a)?;
                self.alert_transform.SetScaleY(&a)?;
            }
            self.device.Commit()?;
        }
        self.motion = Some(motion);
        self.began = Instant::now();
        self.scene = Some(next.clone());
        self.commits += 1;
        Ok(true)
    }
    unsafe fn animation(
        &self,
        motion: Motion,
        from: f32,
        to: f32,
    ) -> Result<IDCompositionAnimation> {
        let a = self.device.CreateAnimation()?;
        if motion.duration == 0.0 {
            a.AddCubic(0.0, to, 0.0, 0.0, 0.0)?;
            a.End(0.0, to)?;
            return Ok(a);
        }
        if motion.delay > 0.0 {
            a.AddCubic(0.0, from, 0.0, 0.0, 0.0)?;
        }
        let step = motion.duration / 40.0;
        for index in 0..40 {
            let begin = from + (to - from) * motion.stop(index);
            let end = from + (to - from) * motion.stop(index + 1);
            a.AddCubic(
                motion.delay + step * index as f64,
                begin,
                (end - begin) / step as f32,
                0.0,
                0.0,
            )?;
        }
        a.End(motion.delay + motion.duration, to)?;
        Ok(a)
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        unsafe {
            let _ = self.target.SetRoot(None);
            let _ = self.device.Commit();
        }
    }
}
unsafe fn rectangle(
    clip: &IDCompositionRectangleClip,
    width: f32,
    height: f32,
    top: f32,
    bottom: f32,
) -> Result<()> {
    clip.SetLeft2(0.0)?;
    clip.SetTop2(0.0)?;
    clip.SetRight2(width)?;
    clip.SetBottom2(height)?;
    clip.SetTopLeftRadiusX2(top)?;
    clip.SetTopLeftRadiusY2(top)?;
    clip.SetTopRightRadiusX2(top)?;
    clip.SetTopRightRadiusY2(top)?;
    clip.SetBottomLeftRadiusX2(bottom)?;
    clip.SetBottomLeftRadiusY2(bottom)?;
    clip.SetBottomRightRadiusX2(bottom)?;
    clip.SetBottomRightRadiusY2(bottom)?;
    Ok(())
}
