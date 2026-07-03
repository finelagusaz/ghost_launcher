use std::path::Path;
use std::process::Command;

/// SSP へ渡すゴースト指定引数を構築する。
/// SSP 内ゴースト（source == "ssp"）はディレクトリ名のみ、外部ゴーストはフルパス。
fn build_ghost_arg(ghost_source: &str, ghost_directory_name: &str) -> String {
    if ghost_source == "ssp" {
        ghost_directory_name.to_string()
    } else {
        Path::new(ghost_source)
            .join(ghost_directory_name)
            .to_string_lossy()
            .into_owned()
    }
}

/// SSP フォルダのパスを検証する（ssp.exe の存在確認）
#[tauri::command]
pub fn validate_ssp_path(ssp_path: String) -> Result<(), String> {
    let ssp_exe = Path::new(&ssp_path).join("ssp.exe");
    if !ssp_exe.exists() {
        return Err(format!("ssp.exe が見つかりません: {}", ssp_exe.display()));
    }
    Ok(())
}

/// SSP.exe を指定したゴーストで起動する
#[tauri::command]
pub fn launch_ghost(
    ssp_path: String,
    ghost_directory_name: String,
    ghost_source: String,
) -> Result<(), String> {
    let ssp_exe = Path::new(&ssp_path).join("ssp.exe");

    if !ssp_exe.exists() {
        return Err(format!("ssp.exe が見つかりません: {}", ssp_exe.display()));
    }

    let ghost_arg = build_ghost_arg(&ghost_source, &ghost_directory_name);

    Command::new(&ssp_exe)
        .arg("/g")
        .arg(&ghost_arg)
        .current_dir(&ssp_path)
        .spawn()
        .map_err(|e| format!("SSP の起動に失敗しました: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{build_ghost_arg, validate_ssp_path};

    #[test]
    fn ssp内ゴーストはディレクトリ名のみを渡す() {
        assert_eq!(build_ghost_arg("ssp", "my_ghost"), "my_ghost");
    }

    #[test]
    fn 外部ゴーストはsourceと結合したフルパスを渡す() {
        assert_eq!(
            build_ghost_arg("C:\\Ghosts\\Extra", "my_ghost"),
            "C:\\Ghosts\\Extra\\my_ghost"
        );
    }

    #[test]
    fn validate_ssp_path_はssp_exe不在でエラーを返す() {
        let result = validate_ssp_path("C:\\__ghost_launcher_no_such_dir__".to_string());
        assert!(result.is_err());
    }
}
