//! Explicit link capture and read-only, allow-listed bookmark import.
pub mod capture;
pub mod intake;
pub mod parse;
pub mod picker;
pub mod service;
pub mod sources;
pub mod store;
#[cfg(test)]
mod tests;
pub mod title;
#[cfg(test)]
mod title_tests;
