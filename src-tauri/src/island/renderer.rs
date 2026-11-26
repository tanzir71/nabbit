//! Static native compact surface selected by the V0 gate. No render timer.
use super::model::{idle_geometry, Placement, Shape};
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
            target.SetRoot(&scene)?;
            let mut renderer = Self {
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
        let geometry = idle_geometry(placement.shape);
        let scale = placement.render_scale as f32;
        let width = geometry.width as f32 * scale;
        let height = geometry.height as f32 * scale;
        let x = (placement.bounds.width as f32 - width) / 2.0;
        unsafe {
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
