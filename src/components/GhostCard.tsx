import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Card, Text, makeStyles, tokens } from "@fluentui/react-components";
import { PlayRegular } from "@fluentui/react-icons";
import { buildLaunchErrorMessage, getSourceFolderLabel } from "../lib/ghostLaunchUtils";
import type { Ghost } from "../types";

interface Props {
  ghost: Ghost;
  sspPath: string;
}

const useStyles = makeStyles({
  card: {
    padding: "12px 16px",
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    transitionDuration: tokens.durationNormal,
    transitionProperty: "background-color, border-color",
    transitionTimingFunction: tokens.curveEasyEase,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "16px",
    alignItems: "center",
    "@media (max-width: 600px)": {
      gridTemplateColumns: "1fr",
      gap: "10px",
      alignItems: "stretch",
    },
  },
  info: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  name: {
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
  },
  meta: {
    color: tokens.colorNeutralForeground3,
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
    "@media (max-width: 600px)": {
      display: "flex",
      flexWrap: "wrap",
      whiteSpace: "normal",
      textOverflow: "clip",
      overflow: "visible",
    },
  },
  sourceBadge: {
    flexShrink: 0,
  },
  launchButton: {
    flexShrink: 0,
    "@media (max-width: 600px)": {
      width: "100%",
    },
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

export function GhostCard({ ghost, sspPath }: Props) {
  const styles = useStyles();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceFolderLabel = ghost.source !== "ssp" ? getSourceFolderLabel(ghost.source) : null;

  const handleLaunch = async () => {
    setLaunching(true);
    setError(null);
    try {
      await invoke("launch_ghost", {
        sspPath,
        ghostDirectoryName: ghost.directory_name,
        ghostSource: ghost.source,
      });
    } catch (e) {
      setError(buildLaunchErrorMessage(e));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Card className={styles.card} appearance="subtle">
      <div className={styles.row}>
        <div className={styles.info}>
          <Text weight="semibold" className={styles.name}>
            {ghost.name}
          </Text>
          <Text className={styles.meta}>
            {ghost.directory_name}
            {sourceFolderLabel && (
              <Badge appearance="outline" className={styles.sourceBadge}>
                {sourceFolderLabel}
              </Badge>
            )}
          </Text>
        </div>
        <Button
          className={styles.launchButton}
          icon={<PlayRegular />}
          appearance="primary"
          onClick={handleLaunch}
          disabled={launching}
        >
          {launching ? "起動中..." : "起動"}
        </Button>
      </div>
      {error && (
        <Text role="alert" className={styles.error}>
          {error}
        </Text>
      )}
    </Card>
  );
}
