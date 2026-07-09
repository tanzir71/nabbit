use std::path::Path;

use crate::{db::models::DownloadMetadata, download::ytdlp, error::Result};

pub fn probe(app_data_dir: &Path, url: &str) -> Result<DownloadMetadata> {
    ytdlp::probe_metadata(app_data_dir, url)
}
