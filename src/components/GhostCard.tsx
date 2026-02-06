import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Card, Text, makeStyles, tokens } from "@fluentui/react-components";
import { PlayRegular } from "@fluentui/react-icons";
import type { Ghost } from "../types";

interface Props {
  ghost: Ghost;
  sspPath: string;
}

const useStyles = makeStyles({
  card: {
    padding: "14px 16px",
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    backdropFilter: "blur(8px)",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    transitionDuration: tokens.durationNormal,
    transitionProperty: "transform, box-shadow",
    transitionTimingFunction: tokens.curveEasyEase,
    ":hover": {
      transform: "translateY(-1px)",
      boxShadow: tokens.shadow16,
    },
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "12px",
    alignItems: "center",
  },
  info: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "4px",
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
    gap: "6px",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
  },
  sourceBadge: {
    flexShrink: 0,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
});

function getSourceFolderLabel(source: string): string {
  return source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || source;
}

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
      setError(String(e));
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
