//! Private embedded fonts: no system installation, filesystem or font service.
use windows::{
    core::{w, Interface, Result},
    Win32::Graphics::DirectWrite::*,
};

pub struct Fonts {
    pub factory: IDWriteFactory5,
    collection: Option<IDWriteFontCollection>,
    loader: IDWriteInMemoryFontFileLoader,
}

impl Fonts {
    pub fn new() -> Result<Self> {
        unsafe {
            let factory: IDWriteFactory5 = DWriteCreateFactory(DWRITE_FACTORY_TYPE_ISOLATED)?;
            let loader = factory.CreateInMemoryFontFileLoader()?;
            factory.RegisterFontFileLoader(&loader)?;
            // Own registration immediately, so any later failure also unregisters it.
            let mut fonts = Self {
                factory,
                collection: None,
                loader,
            };
            let builder = fonts.factory.CreateFontSetBuilder()?;
            for bytes in [
                include_bytes!("../../src/assets/fonts/Geist-Variable.ttf").as_slice(),
                include_bytes!("../../src/assets/fonts/GeistMono-Variable.ttf").as_slice(),
            ] {
                // NULL owner asks DirectWrite to copy the embedded bytes.
                let file = fonts.loader.CreateInMemoryFontFileReference(
                    &fonts.factory,
                    bytes.as_ptr().cast(),
                    bytes.len() as u32,
                    None,
                )?;
                builder.AddFontFile(&file)?;
            }
            let set = builder.CreateFontSet()?;
            fonts.collection = Some(
                fonts
                    .factory
                    .CreateFontCollectionFromFontSet(&set)?
                    .cast()?,
            );
            // Require real bundled faces at the exact Figma weights; no silent
            // system-font fallback if an upstream font ever changes its names.
            for (name, weight) in [
                (w!("Geist"), DWRITE_FONT_WEIGHT_NORMAL),
                (w!("Geist Mono"), DWRITE_FONT_WEIGHT_MEDIUM),
            ] {
                let mut index = 0;
                let mut exists = windows::core::BOOL(0);
                fonts
                    .collection()
                    .FindFamilyName(name, &mut index, &mut exists)?;
                if !exists.as_bool() {
                    return Err(windows::core::Error::new(
                        windows::core::HRESULT(0x80004005u32 as i32),
                        "Bundled font family missing",
                    ));
                }
                let font = fonts
                    .collection()
                    .GetFontFamily(index)?
                    .GetFirstMatchingFont(
                        weight,
                        DWRITE_FONT_STRETCH_NORMAL,
                        DWRITE_FONT_STYLE_NORMAL,
                    )?;
                if font.GetWeight() != weight
                    || font.GetSimulations() != DWRITE_FONT_SIMULATIONS_NONE
                {
                    return Err(windows::core::Error::new(
                        windows::core::HRESULT(0x80004005u32 as i32),
                        "Bundled font weight missing or simulated",
                    ));
                }
            }
            Ok(fonts)
        }
    }

    pub fn collection(&self) -> &IDWriteFontCollection {
        self.collection
            .as_ref()
            .expect("initialized private font collection")
    }
}

impl Drop for Fonts {
    fn drop(&mut self) {
        self.collection.take();
        unsafe {
            let _ = self.factory.UnregisterFontFileLoader(&self.loader);
        }
    }
}
