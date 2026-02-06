import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  sspPath: string | null;
  onPathChange: (path: string) => void;
  ghostFolders: string[];
  onAddFolder: (folder: string) => void;
  onRemoveFolder: (folder: string) => void;
}

export function SettingsPanel({
  sspPath,
  onPathChange,
  ghostFolders,
  onAddFolder,
  onRemoveFolder,
}: Props) {
  const handleSelectFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "SSPフォルダを選択",
    });
    if (selected) {
      onPathChange(selected);
    }
  };

  const handleAddGhostFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "ゴーストフォルダを追加",
    });
    if (selected) {
      onAddFolder(selected);
    }
  };

  return (
    <div className="settings-panel">
      <div className="settings-row">
        <label className="settings-label">SSPフォルダ:</label>
        <span className="settings-path" title={sspPath ?? undefined}>
          {sspPath ?? "未設定"}
        </span>
        <button className="btn btn-secondary" onClick={handleSelectFolder}>
          選択
        </button>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <label className="settings-label">追加ゴーストフォルダ:</label>
          <button className="btn btn-secondary btn-small" onClick={handleAddGhostFolder}>
            追加
          </button>
        </div>
        {ghostFolders.length === 0 && (
          <div className="settings-empty">追加フォルダなし</div>
        )}
        {ghostFolders.map((folder) => (
          <div key={folder} className="settings-folder-row">
            <span className="settings-path" title={folder}>
              {folder}
            </span>
            <button
              className="btn btn-danger btn-small"
              onClick={() => onRemoveFolder(folder)}
            >
              削除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
