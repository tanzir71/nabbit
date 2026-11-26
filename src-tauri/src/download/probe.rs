use std::path::Path;

use crate::{db::models::DownloadMetadata, download::ytdlp, error::Result};

pub fn probe(app_data_dir: &Path, url: &str) -> Result<DownloadMetadata> {
    if super::acceptance::fake() {
        return super::acceptance::metadata(url);
    }
    ytdlp::probe_metadata(app_data_dir, url)
}
