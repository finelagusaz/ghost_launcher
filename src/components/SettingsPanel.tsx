import { useState } from "react";
import { useTranslation } from "react-i18next";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Field,
  Input,
  Select,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AddRegular, DeleteRegular, FolderOpenRegular } from "@fluentui/react-icons";
import { SUPPORTED_LANGUAGES, type Language } from "../lib/i18n";
import { validateSspPath } from "../lib/sspClient";
import { describeError, formatErrorDetail } from "../lib/errorMessages";
import type { AddFolderOutcome } from "../hooks/useSettings";

interface Props {
  sspPath: string | null;
  /// 保存に失敗したら reject する（パネルが画面に知らせる）
  onPathChange: (path: string) => Promise<void>;
  ghostFolders: string[];
  /// 拒否したときは理由を返し、保存に失敗したら reject する
  onAddFolder: (folder: string) => Promise<AddFolderOutcome>;
  /// 保存に失敗したら reject する
  onRemoveFolder: (folder: string) => Promise<void>;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  languageApplying?: boolean;
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
  // 1カラムに崩れたとき直上のフィールドとの関連を保つためボタンを全幅にする
  responsiveButton: {
    "@media (max-width: 600px)": {
      width: "100%",
    },
  },
  empty: {
    color: tokens.colorNeutralForeground3,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

/// パネルに出す失敗。文言は描画時に組み立てる（このダイアログ内で言語を切り替えても、
/// 表示中の失敗が追従する）。key が無いものは、捕まえた値そのものを文言にする（SSP の検証エラー）。
interface PanelNotice {
  key?: string;
  cause?: unknown;
}

function useNoticeText() {
  const { t } = useTranslation();
  return (notice: PanelNotice | null): string | undefined => {
    if (!notice) return undefined;
    if (!notice.key) return describeError(notice.cause, t);
    return t(notice.key, { detail: notice.cause === undefined ? "" : formatErrorDetail(notice.cause, t) });
  };
}

export function SettingsPanel({
  sspPath,
  onPathChange,
  ghostFolders,
  onAddFolder,
  onRemoveFolder,
  language,
  onLanguageChange,
  languageApplying = false,
}: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  const noticeText = useNoticeText();
  const [sspNotice, setSspNotice] = useState<PanelNotice | null>(null);
  const [folderNotice, setFolderNotice] = useState<PanelNotice | null>(null);
  const [validating, setValidating] = useState(false);

  /// フォルダ選択ダイアログを開く。開けなかったら知らせて null を返す。
  const pickFolder = async (
    title: string,
    notify: (notice: PanelNotice) => void,
  ): Promise<string | null> => {
    try {
      return await open({ directory: true, multiple: false, title });
    } catch (e) {
      notify({ key: "settings.dialogFailed", cause: e });
      return null;
    }
  };

  const handleSelectFolder = async () => {
    setSspNotice(null);
    const selected = await pickFolder(t("settings.ssp.dialogTitle"), setSspNotice);
    if (!selected) return;

    setValidating(true);
    try {
      try {
        await validateSspPath(selected);
      } catch (e) {
        setSspNotice({ cause: e });
        return;
      }
      try {
        await onPathChange(selected);
      } catch (e) {
        setSspNotice({ key: "settings.saveFailed", cause: e });
      }
    } finally {
      setValidating(false);
    }
  };

  const handleAddGhostFolder = async () => {
    setFolderNotice(null);
    const selected = await pickFolder(t("settings.folders.addDialogTitle"), setFolderNotice);
    if (!selected) return;
    try {
      const outcome = await onAddFolder(selected);
      if (outcome !== "added") {
        setFolderNotice({ key: `settings.folders.${outcome}` });
      }
    } catch (e) {
      setFolderNotice({ key: "settings.saveFailed", cause: e });
    }
  };

  const handleRemoveFolder = async (folder: string) => {
    setFolderNotice(null);
    let approved: boolean;
    try {
      approved = await confirm(
        t("settings.folders.deleteConfirm", { folder }),
        {
          title: t("settings.folders.deleteTitle"),
          kind: "warning",
          okLabel: t("settings.folders.deleteOk"),
          cancelLabel: t("settings.folders.deleteCancel"),
        },
      );
    } catch (e) {
      setFolderNotice({ key: "settings.dialogFailed", cause: e });
      return;
    }
    if (!approved) return;
    try {
      await onRemoveFolder(folder);
    } catch (e) {
      setFolderNotice({ key: "settings.saveFailed", cause: e });
    }
  };

  const sspMessage = noticeText(sspNotice);
  const folderMessage = noticeText(folderNotice);

  return (
    <div className={styles.panel}>
      <Field
        label={t("settings.language.label")}
        validationMessage={languageApplying ? <Spinner size="tiny" label={t("app.loading")} /> : undefined}
      >
        <Select
          value={language}
          onChange={(_: unknown, data: { value: string }) => onLanguageChange(data.value as Language)}
          disabled={languageApplying}
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
          validationState={sspMessage ? "error" : undefined}
          validationMessage={sspMessage}
        >
          <Input readOnly value={sspPath ?? t("settings.ssp.unset")} />
        </Field>
        <Button
          className={styles.responsiveButton}
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
        {folderMessage && (
          <Text role="alert" className={styles.error}>
            {folderMessage}
          </Text>
        )}
        {ghostFolders.length === 0 && (
          <Text className={styles.empty}>{t("settings.folders.empty")}</Text>
        )}
        <div className={styles.folderList}>
          {ghostFolders.map((folder) => (
            <div key={folder} className={styles.folderRow}>
              <Input readOnly value={folder} />
              <Button
                className={styles.responsiveButton}
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
