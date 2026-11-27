# Local error-propagation patch

Source: crates.io `drag` 2.1.1, MIT OR Apache-2.0, from
[CrabNebula drag-rs](https://github.com/crabnebula-dev/drag-rs).

Only change: the two Windows `get_file_data_object(&paths).unwrap()` calls
in `src/platform_impl/windows/mod.rs` use `.ok_or(Error::FailedToStartDrag)?`. Shell failures (including
unavailable network items) reach the existing plugin error result instead
of panicking. No drag behavior, file access, format or licence is changed.
The existing failed-drag error represents the missing Shell data object.

Upstream report: [network-path panic #72](https://github.com/crabnebula-dev/drag-rs/issues/72).
Remove the patch when a released dependency propagates both errors.
