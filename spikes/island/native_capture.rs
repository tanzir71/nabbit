//! Acceptance-only capture of this exact HWND. Never captures a monitor/desktop.
//! Uses CreateForWindow interop; no picker or permission/setting changes.
use serde::Serialize;
use std::{path::Path, sync::mpsc, time::Duration};
use windows::{
    core::{factory, Interface, Result},
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::*,
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::HWND,
        Graphics::{
            Direct3D11::*,
            Dxgi::{Common::*, IDXGIDevice},
        },
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
        },
    },
};

#[derive(Serialize)]
pub struct Captured {
    pub width: u32,
    pub height: u32,
    pub format: &'static str,
}
pub fn capture(hwnd: isize, device: &ID3D11Device, path: &Path) -> Result<Captured> {
    unsafe {
        let interop: IGraphicsCaptureItemInterop =
            factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = interop.CreateForWindow(HWND(hwnd as *mut _))?;
        let dxgi: IDXGIDevice = device.cast()?;
        let direct: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &direct,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            item.Size()?,
        )?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let token = pool.FrameArrived(&TypedEventHandler::<
            Direct3D11CaptureFramePool,
            windows::core::IInspectable,
        >::new(move |pool, _| {
            if let Some(pool) = pool.as_ref() {
                if let Ok(frame) = pool.TryGetNextFrame() {
                    let _ = sender.try_send(frame);
                }
            }
            Ok(())
        }))?;
        let session = pool.CreateCaptureSession(&item)?;
        session.SetIsCursorCaptureEnabled(false)?;
        session.StartCapture()?;
        let result = (|| -> Result<Captured> {
            let frame = receiver.recv_timeout(Duration::from_secs(3)).map_err(|_| {
                windows::core::Error::new(
                    windows::core::HRESULT(0x80004005u32 as i32),
                    "Native HWND capture timed out",
                )
            })?;
            let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
            let texture: ID3D11Texture2D = access.GetInterface()?;
            let size = frame.ContentSize()?;
            let (width, height) = (size.Width as u32, size.Height as u32);
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..Default::default()
            };
            let mut staging = None;
            device.CreateTexture2D(&staging_desc, None, Some(&mut staging))?;
            let staging = staging.expect("successful staging allocation");
            let context = device.GetImmediateContext()?;
            context.CopyResource(&staging, &texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let mut bytes = Vec::with_capacity((width * height * 4) as usize);
            for row in 0..height {
                bytes.extend_from_slice(std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add((row * mapped.RowPitch) as usize),
                    (width * 4) as usize,
                ));
            }
            context.Unmap(&staging, 0);
            std::fs::write(path, bytes).map_err(|e| {
                windows::core::Error::new(
                    windows::core::HRESULT(0x80004005u32 as i32),
                    e.to_string(),
                )
            })?;
            frame.Close()?;
            Ok(Captured {
                width,
                height,
                format: "BGRA8 premultiplied; own HWND only",
            })
        })();
        let _ = session.Close();
        let _ = pool.RemoveFrameArrived(token);
        let _ = pool.Close();
        result
    }
}
