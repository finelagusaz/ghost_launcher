import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Text, Tooltip, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowClockwiseRegular, ArrowShuffleRegular, SettingsRegular } from "@fluentui/react-icons";

interface Props {
  sspPath: string | null;
  ghostsLoading: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onRandomLaunch: () => Promise<void>;
}

const useStyles = makeStyles({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    flexWrap: "wrap",
    gap: "12px",
    minWidth: 0,
    paddingBottom: "16px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  titleBlock: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minWidth: 0,
    flex: 1,
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  title: {
    fontSize: "clamp(1.5rem, 5vw, 2rem)",
    lineHeight: tokens.lineHeightBase600,
    fontWeight: tokens.fontWeightSemibold,
  },
});

export const AppHeader = memo(function AppHeader({ sspPath, ghostsLoading, onRefresh, onOpenSettings, onRandomLaunch }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [randomLaunching, setRandomLaunching] = useState(false);

  const handleRandomLaunch = useCallback(async () => {
    setRandomLaunching(true);
    try {
      await onRandomLaunch();
    } finally {
      setRandomLaunching(false);
    }
  }, [onRandomLaunch]);

  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <Text as="h1" className={styles.title}>
          Ghost Launcher
        </Text>
      </div>
      <div className={styles.headerActions}>
        {sspPath && (
          <>
            <Tooltip content={t("header.randomLaunch")} relationship="label">
              <Button
                icon={<ArrowShuffleRegular />}
                appearance="subtle"
                onClick={handleRandomLaunch}
                disabled={ghostsLoading || randomLaunching}
                data-testid="random-launch-button"
              />
            </Tooltip>
            <Button
              icon={<ArrowClockwiseRegular />}
              appearance="secondary"
              onClick={onRefresh}
              disabled={ghostsLoading}
            >
              {t("header.refresh")}
            </Button>
          </>
        )}
        <Button icon={<SettingsRegular />} appearance="secondary" onClick={onOpenSettings} data-testid="settings-button">
          {t("header.settings")}
        </Button>
      </div>
    </header>
  );
});
