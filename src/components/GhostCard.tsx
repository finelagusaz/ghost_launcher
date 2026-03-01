import { memo, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Badge,
  Button,
  Card,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { PlayRegular } from "@fluentui/react-icons";
import { getSourceFolderLabel } from "../lib/ghostLaunchUtils";
import { formatErrorDetail } from "../lib/ghostScanUtils";
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
    transitionProperty: "background-color, box-shadow",
    transitionTimingFunction: tokens.curveEasyEase,
    ":hover": {
      backgroundColor: tokens.colorNeutralBackground2,
      boxShadow: tokens.shadow8,
    },
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "16px",
    alignItems: "center",
    "@media (max-width: 600px)": {
      gridTemplateColumns: "1fr",
      gap: "12px",
      alignItems: "stretch",
    },
  },
  info: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  name: {
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
    overflow: "hidden",
    color: tokens.colorNeutralForeground3,
  },
  sourceBadge: {
    flexShrink: 0,
  },
  metaText: {
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
    minWidth: 0,
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

// テキストが溢れているときだけ Tooltip を表示するヘルパー
function TruncatedText({
  content,
  className,
  weight,
}: {
  content: string;
  className?: string;
  weight?: "regular" | "medium" | "semibold" | "bold";
}) {
  const ref = useRef<HTMLElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setIsTruncated(el.scrollWidth > el.clientWidth);
  }, []);

  const text = (
    <Text ref={ref} className={className} weight={weight}>
      {content}
    </Text>
  );

  if (!isTruncated) return text;

  return (
    <Tooltip content={content} relationship="label">
      {text}
    </Tooltip>
  );
}

export const GhostCard = memo(function GhostCard({ ghost, sspPath }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
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
      setError(t("card.launchError", { detail: formatErrorDetail(e) }));
    } finally {
      setLaunching(false);
    }
  };

  const metaContent = ghost.craftman
    ? `${ghost.directory_name} · ${ghost.craftman}`
    : ghost.directory_name;

  return (
    <Card className={styles.card} appearance="outline">
      <div className={styles.row}>
        <div className={styles.info}>
          <TruncatedText
            weight="semibold"
            content={ghost.name}
            className={styles.name}
          />
          <div className={styles.meta}>
            {sourceFolderLabel && (
              <Badge appearance="outline" className={styles.sourceBadge}>
                {sourceFolderLabel}
              </Badge>
            )}
            <TruncatedText content={metaContent} className={styles.metaText} />
          </div>
        </div>
        <Button
          className={styles.launchButton}
          icon={<PlayRegular />}
          appearance="outline"
          onClick={handleLaunch}
          disabled={launching}
          data-testid="launch-button"
        >
          {launching ? t("card.launching") : t("card.launch")}
        </Button>
      </div>
      {error && (
        <Text role="alert" className={styles.error}>
          {error}
        </Text>
      )}
    </Card>
  );
});
