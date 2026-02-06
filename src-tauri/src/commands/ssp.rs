use std::path::Path;
use std::process::Command;

/// SSP.exe を指定したゴーストで起動する
#[tauri::command]
pub fn launch_ghost(ssp_path: String, ghost_directory_name: String) -> Result<(), String> {
    let ssp_exe = Path::new(&ssp_path).join("ssp.exe");

    if !ssp_exe.exists() {
        return Err(format!("ssp.exe が見つかりません: {}", ssp_exe.display()));
    }

    Command::new(&ssp_exe)
        .arg("/g")
        .arg(&ghost_directory_name)
        .current_dir(&ssp_path)
        .spawn()
        .map_err(|e| format!("SSP の起動に失敗しました: {}", e))?;

    Ok(())
}
