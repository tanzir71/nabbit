use super::presentation::{Compact, Draw};
use windows::{
    core::{w, Interface, Result},
    Win32::{
        Foundation::POINT,
        Graphics::{
            Direct2D::{Common::*, *},
            DirectComposition::*,
            DirectWrite::*,
            Dxgi::Common::*,
        },
        UI::Shell::SHCreateMemStream,
    },
};
use windows_numerics::{Matrix3x2, Vector2};
pub struct Painter {
    fonts: super::fonts::Fonts,
    artwork: std::cell::RefCell<Option<(String, ID2D1Bitmap)>>,
}
impl Painter {
    pub fn new() -> Result<Self> {
        Ok(Self {
            fonts: super::fonts::Fonts::new()?,
            artwork: std::cell::RefCell::new(None),
        })
    }
    pub fn draw(
        &self,
        device: &IDCompositionDevice3,
        scene: &Compact,
        scale: f32,
    ) -> Result<IDCompositionSurface> {
        unsafe {
            let surface = device.CreateSurface(
                (scene.width * scale).ceil() as u32,
                (32.0 * scale).ceil() as u32,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                DXGI_ALPHA_MODE_PREMULTIPLIED,
            )?;
            let mut offset = POINT::default();
            let dc: ID2D1DeviceContext = surface.BeginDraw(None, &mut offset)?;
            let drawn = (|| -> Result<()> {
                dc.SetDpi(96.0 * scale, 96.0 * scale);
                dc.Clear(Some(&color(0, 0, 0, 0.0)));
                dc.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
                let ox = offset.x as f32 / scale;
                let oy = offset.y as f32 / scale;
                self.commands(
                    &dc,
                    &scene.primary,
                    ox,
                    oy,
                    scene.primary_width - if scene.notch { 4.0 } else { 0.0 },
                )?;
                if !scene.bubble.is_empty() {
                    let x = ox + scene.primary_width + 6.0;
                    dc.SetTransform(&translation(x, oy));
                    let brush = dc.CreateSolidColorBrush(&color(5, 5, 6, 1.0), None)?;
                    dc.FillRoundedRectangle(
                        &D2D1_ROUNDED_RECT {
                            rect: D2D_RECT_F {
                                left: 0.0,
                                top: 0.0,
                                right: 32.0,
                                bottom: 32.0,
                            },
                            radiusX: 16.0,
                            radiusY: 16.0,
                        },
                        &brush,
                    );
                    self.commands(&dc, &scene.bubble, x, oy, 32.0)?;
                }
                Ok(())
            })();
            let ended = surface.EndDraw();
            drawn?;
            ended?;
            Ok(surface)
        }
    }
    unsafe fn commands(
        &self,
        dc: &ID2D1DeviceContext,
        commands: &[Draw],
        ox: f32,
        oy: f32,
        canvas_width: f32,
    ) -> Result<()> {
        for command in commands {
            dc.SetTransform(&translation(ox, oy));
            match command {
                Draw::Level { x, width, value } => {
                    let track = dc.CreateSolidColorBrush(&color(44, 44, 47, 1.0), None)?;
                    let fill = dc.CreateSolidColorBrush(&color(245, 245, 243, 1.0), None)?;
                    let rect = |right| D2D1_ROUNDED_RECT {
                        rect: D2D_RECT_F {
                            left: *x,
                            top: 14.0,
                            right,
                            bottom: 18.0,
                        },
                        radiusX: 2.0,
                        radiusY: 2.0,
                    };
                    dc.FillRoundedRectangle(&rect(*x + *width), &track);
                    dc.FillRoundedRectangle(
                        &rect(*x + *width * value.clamp(0.0, 100.0) / 100.0),
                        &fill,
                    );
                }
                Draw::Icon { name, x } => self.icon(dc, name, ox + *x, oy)?,
                Draw::Text {
                    value,
                    x,
                    width,
                    mono,
                    strong,
                    muted,
                } => self.text(
                    dc,
                    value,
                    *x,
                    *width,
                    *mono,
                    *strong,
                    *muted,
                    false,
                    *mono && *x + *width >= canvas_width - 10.1,
                )?,
                Draw::Button {
                    label,
                    x,
                    width,
                    signal,
                } => {
                    let brush = dc.CreateSolidColorBrush(
                        &if *signal {
                            color(198, 242, 78, 1.0)
                        } else {
                            color(28, 28, 30, 1.0)
                        },
                        None,
                    )?;
                    dc.FillRoundedRectangle(
                        &D2D1_ROUNDED_RECT {
                            rect: D2D_RECT_F {
                                left: *x,
                                top: 5.0,
                                right: *x + *width,
                                bottom: 27.0,
                            },
                            radiusX: 11.0,
                            radiusY: 11.0,
                        },
                        &brush,
                    );
                    let has_icon = matches!(*label, "Nab it" | "Fix");
                    if has_icon {
                        self.icon(
                            dc,
                            if *label == "Fix" {
                                "iconWrench"
                            } else {
                                "iconDownload"
                            },
                            ox + *x + 10.0,
                            oy,
                        )?;
                        dc.SetTransform(&translation(ox, oy));
                    }
                    self.text(
                        dc,
                        label,
                        *x + if has_icon { 27.0 } else { 10.0 },
                        *width - if has_icon { 37.0 } else { 20.0 },
                        false,
                        true,
                        false,
                        *signal,
                        false,
                    )?;
                }
                Draw::Ring { value, x } => {
                    let track = dc.CreateSolidColorBrush(&color(44, 44, 47, 1.0), None)?;
                    let active = dc.CreateSolidColorBrush(&color(198, 242, 78, 1.0), None)?;
                    dc.DrawEllipse(
                        &D2D1_ELLIPSE {
                            point: Vector2 {
                                X: *x + 9.0,
                                Y: 16.0,
                            },
                            radiusX: 7.65,
                            radiusY: 7.65,
                        },
                        &track,
                        2.7,
                        None,
                    );
                    let steps = (value.clamp(0.0, 100.0) * 1.28).ceil() as usize;
                    for index in 0..steps {
                        let a = -std::f32::consts::FRAC_PI_2
                            + index as f32 / 128.0 * std::f32::consts::TAU;
                        let b = -std::f32::consts::FRAC_PI_2
                            + ((index + 1) as f32 / 128.0).min(value.clamp(0.0, 100.0) / 100.0)
                                * std::f32::consts::TAU;
                        dc.DrawLine(
                            Vector2 {
                                X: *x + 9.0 + 7.65 * a.cos(),
                                Y: 16.0 + 7.65 * a.sin(),
                            },
                            Vector2 {
                                X: *x + 9.0 + 7.65 * b.cos(),
                                Y: 16.0 + 7.65 * b.sin(),
                            },
                            &active,
                            2.7,
                            None,
                        );
                    }
                }
                Draw::Artwork { x, art } => {
                    if let Some(art) = art {
                        if self.artwork(dc, art, *x)? {
                            continue;
                        }
                    }
                    let base: ID2D1RenderTarget = dc.cast()?;
                    let stops = base.CreateGradientStopCollection(
                        &[
                            D2D1_GRADIENT_STOP {
                                position: 0.0,
                                color: color(242, 140, 89, 1.0),
                            },
                            D2D1_GRADIENT_STOP {
                                position: 0.71429,
                                color: color(115, 51, 140, 1.0),
                            },
                        ],
                        D2D1_GAMMA_2_2,
                        D2D1_EXTEND_MODE_CLAMP,
                    )?;
                    let brush = dc.CreateLinearGradientBrush(
                        &D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES {
                            startPoint: Vector2 { X: *x, Y: 6.0 },
                            endPoint: Vector2 {
                                X: *x + 20.0,
                                Y: 26.0,
                            },
                        },
                        None,
                        &stops,
                    )?;
                    dc.FillRoundedRectangle(
                        &D2D1_ROUNDED_RECT {
                            rect: D2D_RECT_F {
                                left: *x,
                                top: 6.0,
                                right: *x + 20.0,
                                bottom: 26.0,
                            },
                            radiusX: 5.0,
                            radiusY: 5.0,
                        },
                        &brush,
                    );
                }
                Draw::Bars { x, playing } => {
                    let brush = dc.CreateSolidColorBrush(&color(245, 245, 243, 1.0), None)?;
                    for (index, height) in [6.0, 12.0, 8.0, 14.0, 5.0].into_iter().enumerate() {
                        let height = if *playing { height } else { 3.0 };
                        let left = *x + index as f32 * 5.0;
                        dc.FillRoundedRectangle(
                            &D2D1_ROUNDED_RECT {
                                rect: D2D_RECT_F {
                                    left,
                                    top: 16.0 - height / 2.0,
                                    right: left + 3.0,
                                    bottom: 16.0 + height / 2.0,
                                },
                                radiusX: 1.5,
                                radiusY: 1.5,
                            },
                            &brush,
                        );
                    }
                }
                Draw::Dot { x, camera } => self.privacy_dot(dc, ox + *x, oy, *camera)?,
            }
        }
        Ok(())
    }
    unsafe fn artwork(&self, dc: &ID2D1DeviceContext, value: &str, x: f32) -> Result<bool> {
        let base: ID2D1RenderTarget = dc.cast()?;
        let mut cached = self.artwork.borrow_mut();
        if cached.as_ref().is_none_or(|(key, _)| key != value) {
            let Some(pixels) = super::artwork::decode(value) else {
                return Ok(false);
            };
            let bitmap = base.CreateBitmap(
                D2D_SIZE_U {
                    width: pixels.width,
                    height: pixels.height,
                },
                Some(pixels.rgba.as_ptr().cast()),
                pixels.width * 4,
                &D2D1_BITMAP_PROPERTIES {
                    pixelFormat: D2D1_PIXEL_FORMAT {
                        format: DXGI_FORMAT_R8G8B8A8_UNORM,
                        alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                    },
                    dpiX: 96.0,
                    dpiY: 96.0,
                },
            )?;
            *cached = Some((value.into(), bitmap));
        }
        let bitmap = &cached.as_ref().expect("cached artwork").1;
        let size = bitmap.GetSize();
        let scale = (20.0 / size.width).max(20.0 / size.height);
        let brush = base.CreateBitmapBrush(bitmap, None, None)?;
        brush.SetTransform(&Matrix3x2 {
            M11: scale,
            M12: 0.0,
            M21: 0.0,
            M22: scale,
            M31: x + (20.0 - size.width * scale) / 2.0,
            M32: 6.0 + (20.0 - size.height * scale) / 2.0,
        });
        dc.FillRoundedRectangle(
            &D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F {
                    left: x,
                    top: 6.0,
                    right: x + 20.0,
                    bottom: 26.0,
                },
                radiusX: 5.0,
                radiusY: 5.0,
            },
            &brush,
        );
        Ok(true)
    }
    unsafe fn icon(&self, dc: &ID2D1DeviceContext, name: &str, x: f32, y: f32) -> Result<()> {
        let Some((bytes, width, height)) = super::assets::icon(name) else {
            return Ok(());
        };
        let stream =
            SHCreateMemStream(Some(bytes)).ok_or_else(windows::core::Error::from_thread)?;
        let svg_dc: ID2D1DeviceContext5 = dc.cast()?;
        let svg = svg_dc.CreateSvgDocument(&stream, D2D_SIZE_F { width, height })?;
        dc.SetTransform(&translation(x, y + (32.0 - height) / 2.0));
        svg_dc.DrawSvgDocument(&svg);
        Ok(())
    }
    unsafe fn privacy_dot(
        &self,
        dc: &ID2D1DeviceContext,
        x: f32,
        y: f32,
        camera: bool,
    ) -> Result<()> {
        if !camera {
            return self.icon(dc, "privacyDot", x, y);
        }
        let (bytes, width, height) =
            super::assets::icon("privacyDot").expect("original privacy asset");
        let stream =
            SHCreateMemStream(Some(bytes)).ok_or_else(windows::core::Error::from_thread)?;
        let svg_dc: ID2D1DeviceContext5 = dc.cast()?;
        let svg = svg_dc.CreateSvgDocument(&stream, D2D_SIZE_F { width, height })?;
        // The original silhouette/viewport is unchanged. Only live camera state
        // supplies the handoff's lime paint; the mic keeps the original amber.
        svg.GetRoot()?.GetFirstChild()?.SetAttributeValue3(
            w!("fill"),
            D2D1_SVG_ATTRIBUTE_STRING_TYPE_SVG,
            w!("#C6F24E"),
        )?;
        dc.SetTransform(&translation(x, y + (32.0 - height) / 2.0));
        svg_dc.DrawSvgDocument(&svg);
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    unsafe fn text(
        &self,
        dc: &ID2D1DeviceContext,
        value: &str,
        x: f32,
        width: f32,
        mono: bool,
        strong: bool,
        muted: bool,
        dark: bool,
        end: bool,
    ) -> Result<()> {
        if width <= 0.0 {
            return Ok(());
        };
        let small = dark || matches!(value, "Open" | "Undo" | "Fix");
        let size = if small {
            11.0
        } else if strong && !mono {
            13.0
        } else {
            12.0
        };
        let line = if strong && !mono && !small {
            18.0
        } else if small {
            14.0
        } else {
            16.0
        };
        let format = self.fonts.factory.CreateTextFormat(
            if mono { w!("Geist Mono") } else { w!("Geist") },
            self.fonts.collection(),
            if mono || strong {
                DWRITE_FONT_WEIGHT_MEDIUM
            } else {
                DWRITE_FONT_WEIGHT_NORMAL
            },
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            size,
            w!("en-us"),
        )?;
        format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
        if end {
            format.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_TRAILING)?;
        }
        format.SetLineSpacing(
            DWRITE_LINE_SPACING_METHOD_UNIFORM,
            line,
            if small {
                11.0
            } else if size == 13.0 {
                13.0
            } else {
                12.0
            },
        )?;
        let sign = self.fonts.factory.CreateEllipsisTrimmingSign(&format)?;
        format.SetTrimming(
            &DWRITE_TRIMMING {
                granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                delimiter: 0,
                delimiterCount: 0,
            },
            &sign,
        )?;
        let layout = self.fonts.factory.CreateTextLayout(
            &value.encode_utf16().collect::<Vec<_>>(),
            &format,
            width,
            line,
        )?;
        let brush = dc.CreateSolidColorBrush(
            &if dark {
                color(23, 23, 26, 1.0)
            } else if muted {
                color(140, 140, 146, 1.0)
            } else {
                color(245, 245, 243, 1.0)
            },
            None,
        )?;
        let base: ID2D1RenderTarget = dc.cast()?;
        base.DrawTextLayout(
            Vector2 {
                X: x,
                Y: (32.0 - line) / 2.0,
            },
            &layout,
            &brush,
            D2D1_DRAW_TEXT_OPTIONS_CLIP,
        );
        Ok(())
    }
}
fn color(r: u8, g: u8, b: u8, a: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F {
        r: r as f32 / 255.0,
        g: g as f32 / 255.0,
        b: b as f32 / 255.0,
        a,
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
