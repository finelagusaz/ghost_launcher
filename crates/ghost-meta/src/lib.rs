use thiserror::Error;

#[derive(Debug, Error)]
pub enum GhostMetaError {
    #[error("I/O エラー: {0}")]
    Io(#[from] std::io::Error),
}

mod descript;
mod ghost;
mod thumbnail;

#[cfg(test)]
pub(crate) mod testutil;

pub use ghost::{GhostMeta, read_ghost};
pub use thumbnail::{AlphaMode, ThumbnailInfo, ThumbnailKind};
