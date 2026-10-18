use std::path::{Path, PathBuf};

pub(crate) fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

pub(crate) fn unique_sorted_additional_folders(
    additional_folders: &[String],
) -> Vec<(String, PathBuf, String)> {
    let mut folders = additional_folders
        .iter()
        .map(|folder| {
            let path = PathBuf::from(folder);
            let normalized = normalize_path(&path);
            (folder.clone(), path, normalized)
        })
        .collect::<Vec<_>>();

    folders.sort_by(|a, b| a.2.cmp(&b.2));
    folders.dedup_by(|a, b| a.2 == b.2);
    folders
}

#[cfg(test)]
mod tests {
    use super::unique_sorted_additional_folders;

    #[test]
    fn unique_sorted_additional_folders_dedupes_by_normalized_path() {
        let folders = vec![
            "C:\\Ghosts\\Extra".to_string(),
            "c:/ghosts/extra".to_string(),
            "C:/Ghosts/Another".to_string(),
        ];

        let actual = unique_sorted_additional_folders(&folders);

        assert_eq!(actual.len(), 2);
        assert_eq!(actual[0].2, "c:/ghosts/another");
        assert_eq!(actual[1].2, "c:/ghosts/extra");
    }
}
