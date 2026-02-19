import { memo } from "react";
import { Button, Text, makeStyles, tokens } from "@fluentui/react-components";
import { ArrowClockwiseRegular, SettingsRegular } from "@fluentui/react-icons";

interface Props {
  sspPath: string | null;
  ghostsLoading: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
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
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    marginLeft: "auto",
  },
  title: {
    fontSize: "clamp(1.5rem, 5vw, 2rem)",
    lineHeight: tokens.lineHeightBase600,
    fontWeight: tokens.fontWeightSemibold,
  },
});

export const AppHeader = memo(function AppHeader({ sspPath, ghostsLoading, onRefresh, onOpenSettings }: Props) {
  const styles = useStyles();

  return (
    <header className={styles.header}>
      <div className={styles.titleBlock}>
        <Text as="h1" className={styles.title}>
          Ghost Launcher
        </Text>
      </div>
      <div className={styles.headerActions}>
        {sspPath && (
          <Button
            icon={<ArrowClockwiseRegular />}
            appearance="secondary"
            onClick={onRefresh}
            disabled={ghostsLoading}
          >
            再読込
          </Button>
        )}
        <Button icon={<SettingsRegular />} appearance="secondary" onClick={onOpenSettings}>
          設定
        </Button>
      </div>
    </header>
  );
});
