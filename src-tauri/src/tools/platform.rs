//! Short-lived WinRT apartments on the blocking tool worker, never the UI thread.
#[cfg(windows)]
pub struct Apartment;
#[cfg(windows)]
impl Apartment {
    pub fn new() -> crate::error::Result<Self> {
        unsafe {
            windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            )
        }
        .map_err(|e| crate::error::msg(e.to_string()))?;
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::WinRT::RoUninitialize() };
    }
}
#[cfg(windows)]
pub fn stream(
    bytes: &[u8],
) -> crate::error::Result<windows::Storage::Streams::InMemoryRandomAccessStream> {
    use windows::Storage::Streams::*;
    let stream = InMemoryRandomAccessStream::new().map_err(|e| crate::error::msg(e.to_string()))?;
    let write = DataWriter::CreateDataWriter(
        &stream
            .GetOutputStreamAt(0)
            .map_err(|e| crate::error::msg(e.to_string()))?,
    )
    .map_err(|e| crate::error::msg(e.to_string()))?;
    write
        .WriteBytes(bytes)
        .map_err(|e| crate::error::msg(e.to_string()))?;
    write
        .StoreAsync()
        .and_then(|a| a.join())
        .map_err(|e| crate::error::msg(e.to_string()))?;
    write
        .DetachStream()
        .map_err(|e| crate::error::msg(e.to_string()))?;
    stream
        .Seek(0)
        .map_err(|e| crate::error::msg(e.to_string()))?;
    Ok(stream)
}
