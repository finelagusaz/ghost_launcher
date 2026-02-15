use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

pub(crate) fn normalize_path(path: &Path) -> String {
    let normalized = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalized.to_string_lossy().replace('\\', "/").to_lowercase()
}

pub(crate) fn modified_nanos(path: &Path) -> Option<u128> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_nanos())
}
