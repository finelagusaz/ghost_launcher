import { open } from "@tauri-apps/plugin-dialog";

interface Props {
  sspPath: string | null;
  onPathChange: (path: string) => void;
}

export function SettingsPanel({ sspPath, onPathChange }: Props) {
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
    </div>
  );
}
