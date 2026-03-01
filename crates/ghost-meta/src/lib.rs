use thiserror::Error;

#[derive(Debug, Error)]
pub enum GhostMetaError {
    #[error("I/O エラー: {0}")]
    Io(#[from] std::io::Error),
}

pub mod descript;
pub mod ghost;
pub mod thumbnail;

pub use descript::parse_descript;
pub use ghost::{read_ghost, scan_ghosts, GhostMeta};
pub use thumbnail::{resolve_thumbnail, AlphaMode, ThumbnailInfo};
