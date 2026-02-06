use std::path::Path;
use std::process::Command;

/// SSP.exe を指定したゴーストで起動する
#[tauri::command]
pub fn launch_ghost(ssp_path: String, ghost_directory_name: String, ghost_source: String) -> Result<(), String> {
    let ssp_exe = Path::new(&ssp_path).join("ssp.exe");

    if !ssp_exe.exists() {
        return Err(format!("ssp.exe が見つかりません: {}", ssp_exe.display()));
    }

    // SSP 内ゴーストはディレクトリ名、外部ゴーストはフルパスで指定
    let ghost_arg = if ghost_source == "ssp" {
        ghost_directory_name
    } else {
        let full_path = Path::new(&ghost_source).join(&ghost_directory_name);
        full_path.to_string_lossy().into_owned()
    };

    Command::new(&ssp_exe)
        .arg("/g")
        .arg(&ghost_arg)
        .current_dir(&ssp_path)
        .spawn()
        .map_err(|e| format!("SSP の起動に失敗しました: {}", e))?;

    Ok(())
}
