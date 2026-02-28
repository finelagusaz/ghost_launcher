import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Field,
  Input,
  Select,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AddRegular, DeleteRegular, FolderOpenRegular } from "@fluentui/react-icons";
import { SUPPORTED_LANGUAGES, type Language } from "../lib/i18n";

interface Props {
  sspPath: string | null;
  onPathChange: (path: string) => void;
  ghostFolders: string[];
  onAddFolder: (folder: string) => void;
  onRemoveFolder: (folder: string) => void;
  language: Language;
  onLanguageChange: (lang: Language) => void;
}

const useStyles = makeStyles({
  panel: {
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
  language,
  onLanguageChange,
}: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  const handleSelectFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.ssp.dialogTitle"),
    });
    if (!selected) {
      setValidationError(null);
      return;
    }

    setValidating(true);
    try {
      await invoke("validate_ssp_path", { sspPath: selected });
      onPathChange(selected);
      setValidationError(null);
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  };

  const handleAddGhostFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.folders.addDialogTitle"),
    });
    if (selected) {
      onAddFolder(selected);
    }
  };

  const handleRemoveFolder = async (folder: string) => {
    try {
      const approved = await confirm(
        t("settings.folders.deleteConfirm", { folder }),
        {
          title: t("settings.folders.deleteTitle"),
          kind: "warning",
          okLabel: t("settings.folders.deleteOk"),
          cancelLabel: t("settings.folders.deleteCancel"),
        },
      );
      if (approved) {
        onRemoveFolder(folder);
      }
    } catch (e) {
      console.error("フォルダ削除の確認中にエラーが発生しました", e);
    }
  };

  return (
    <div className={styles.panel}>
      <Field label={t("settings.language.label")}>
        <Select
          value={language}
          onChange={(_: unknown, data: { value: string }) => onLanguageChange(data.value as Language)}
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {t(`settings.language.${lang}`)}
            </option>
          ))}
        </Select>
      </Field>

      <div className={styles.row}>
        <Field
          label={t("settings.ssp.label")}
          validationState={validationError ? "error" : undefined}
          validationMessage={validationError ?? undefined}
        >
          <Input readOnly value={sspPath ?? t("settings.ssp.unset")} />
        </Field>
        <Button
          icon={<FolderOpenRegular />}
          appearance="secondary"
          onClick={handleSelectFolder}
          disabled={validating}
        >
          {t("settings.ssp.select")}
        </Button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Text weight="semibold">{t("settings.folders.label")}</Text>
          <Button icon={<AddRegular />} appearance="secondary" onClick={handleAddGhostFolder} disabled={validating}>
            {t("settings.folders.add")}
          </Button>
        </div>
        <Text className={styles.helper}>{t("settings.folders.helper")}</Text>
        {ghostFolders.length === 0 && (
          <Text className={styles.empty}>{t("settings.folders.empty")}</Text>
        )}
        <div className={styles.folderList}>
          {ghostFolders.map((folder) => (
            <div key={folder} className={styles.folderRow}>
              <Input readOnly value={folder} />
              <Button
                icon={<DeleteRegular />}
                appearance="outline"
                aria-label={t("settings.folders.deleteAriaLabel", { folder })}
                onClick={() => void handleRemoveFolder(folder)}
              >
                {t("settings.folders.delete")}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
