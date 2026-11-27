//! An explicit copy never enters clipboard history, cloud clipboard or Nabbit.
use super::{
    model::{Error, ErrorCode, Result},
    session::RecoveryCode,
};
pub(crate) const MARKERS: [(&str, u32); 3] = [
    ("ExcludeClipboardContentFromMonitorProcessing", 1),
    ("CanIncludeInClipboardHistory", 0),
    ("CanUploadToCloudClipboard", 0),
];
fn copy_with(
    code: &RecoveryCode,
    mut write: impl FnMut(&[(&str, u32)], &str) -> Result<()>,
) -> Result<()> {
    if code.value().is_empty() || code.value().len() > 512 || code.value().contains('\0') {
        return Err(Error::new(ErrorCode::InvalidInput));
    }
    write(&MARKERS, code.value())
}
pub(crate) fn copy(code: RecoveryCode) -> Result<()> {
    copy_with(&code, |markers, value| {
        #[cfg(windows)]
        {
            use clipboard_win::{options::NoClear, raw, register_format, Clipboard};
            let error = || Error::new(ErrorCode::SecureStorage);
            let _clipboard = Clipboard::new_attempts(10).map_err(|_| error())?;
            raw::empty().map_err(|_| error())?;
            for (name, permission) in markers {
                let format = register_format(name).ok_or_else(error)?;
                raw::set_without_clear(format.get(), &permission.to_ne_bytes())
                    .map_err(|_| error())?;
            }
            raw::set_string_with(value, NoClear).map_err(|_| error())?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (markers, value);
            Err(Error::new(ErrorCode::SecureStorage))
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_copy_requires_all_privacy_markers_before_the_secret_writer() {
        let code = RecoveryCode::new("synthetic-copy-fixture".into());
        let mut calls = 0;
        copy_with(&code, |markers, text| {
            assert_eq!(markers, &MARKERS);
            assert_eq!(text, code.value());
            calls += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 1);
        let err = copy_with(&code, |_, _| Err(Error::new(ErrorCode::SecureStorage))).unwrap_err();
        assert_eq!(err.code, ErrorCode::SecureStorage);
        assert!(copy_with(&RecoveryCode::new(String::new()), |_, _| panic!(
            "invalid input must never reach clipboard"
        ))
        .is_err());
    }
}
