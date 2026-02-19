use std::path::Path;

pub(crate) fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}
