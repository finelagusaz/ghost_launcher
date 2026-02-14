import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Field,
  Input,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AddRegular, DeleteRegular, FolderOpenRegular } from "@fluentui/react-icons";

interface Props {
  sspPath: string | null;
  onPathChange: (path: string) => void;
  ghostFolders: string[];
  onAddFolder: (folder: string) => void;
  onRemoveFolder: (folder: string) => void;
}

const useStyles = makeStyles({
  panel: {
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "12px",
    alignItems: "end",
    "@media (max-width: 600px)": {
      gridTemplateColumns: "1fr",
    },
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    flexWrap: "wrap",
  },
  helper: {
    color: tokens.colorNeutralForeground3,
  },
  folderList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  folderRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "8px",
    alignItems: "center",
    "@media (max-width: 600px)": {
      gridTemplateColumns: "1fr",
    },
  },
  empty: {
    color: tokens.colorNeutralForeground3,
  },
});

export function SettingsPanel({
  sspPath,
  onPathChange,
  ghostFolders,
  onAddFolder,
  onRemoveFolder,
}: Props) {
  const styles = useStyles();

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

  const handleRemoveFolder = async (folder: string) => {
    const approved = await confirm(
      `このフォルダを一覧対象から削除しますか？\n${folder}`,
      {
        title: "追加フォルダの削除",
        kind: "warning",
        okLabel: "削除",
        cancelLabel: "キャンセル",
      },
    );
    if (approved) {
      onRemoveFolder(folder);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.row}>
        <Field label="SSPフォルダ">
          <Input readOnly value={sspPath ?? "未設定"} />
        </Field>
        <Button icon={<FolderOpenRegular />} appearance="secondary" onClick={handleSelectFolder}>
          選択
        </Button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Text weight="semibold">追加ゴーストフォルダ</Text>
          <Button icon={<AddRegular />} appearance="secondary" onClick={handleAddGhostFolder}>
            追加
          </Button>
        </div>
        <Text className={styles.helper}>追加フォルダ内のゴーストを一覧に含めます。</Text>
        {ghostFolders.length === 0 && (
          <Text className={styles.empty}>追加フォルダなし</Text>
        )}
        <div className={styles.folderList}>
          {ghostFolders.map((folder) => (
            <div key={folder} className={styles.folderRow}>
              <Input readOnly value={folder} />
              <Button
                icon={<DeleteRegular />}
                appearance="outline"
                aria-label={`追加フォルダを削除: ${folder}`}
                onClick={() => void handleRemoveFolder(folder)}
              >
                削除
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
