import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
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
  content: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: "12px",
    minWidth: 0,
  },
});

// テキストが溢れているときだけ Tooltip を表示するヘルパー
const TruncatedText = memo(function TruncatedText({
  content,
  className,
  weight,
  testId,
}: {
  content: string;
  className?: string;
  weight?: "regular" | "medium" | "semibold" | "bold";
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setIsTruncated(el.scrollWidth > el.clientWidth);
  }, []);

  const text = (
    <Text ref={ref} className={className} weight={weight} data-testid={testId}>
      {content}
    </Text>
  );

  if (!isTruncated) return text;

  return (
    <Tooltip content={content} relationship="label">
      {text}
    </Tooltip>
  );
});

// KeyColor 透過: 左上ピクセルをキーカラーとして透明化する canvas コンポーネント
const ThumbnailCanvas = memo(function ThumbnailCanvas({ src }: { src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const [keyR, keyG, keyB] = [data[0], data[1], data[2]];
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === keyR && data[i + 1] === keyG && data[i + 2] === keyB) {
            data[i + 3] = 0;
          }
        }
        ctx.putImageData(imageData, 0, 0);
      } catch {
        // CORS 等で getImageData が失敗した場合はそのまま表示
      }
    };
    img.src = src;
  }, [src]);
  return <canvas ref={canvasRef} style={{ maxHeight: "50vh", maxWidth: "40vw" }} />;
});

export const GhostCard = memo(function GhostCard({ ghost, sspPath }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
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
    ? `${ghost.directory_name} | ${ghost.craftman}`
    : ghost.directory_name;

  const thumbnailSrc = ghost.thumbnail_path ? convertFileSrc(ghost.thumbnail_path) : null;

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    pointerEvents: "none",
    zIndex: 10000,
    bottom: ghost.thumbnail_kind === "surface" ? 0 : "20px",
    right: ghost.thumbnail_kind === "surface" ? 0 : "20px",
  };

  return (
    <Card
      className={styles.card}
      appearance="outline"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={styles.row}>
        <div className={styles.content}>
          <div className={styles.info}>
            <TruncatedText
              weight="semibold"
              content={ghost.name}
              className={styles.name}
              testId="ghost-name"
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
      {hovered && thumbnailSrc && createPortal(
        <div style={overlayStyle}>
          {Boolean(ghost.thumbnail_use_self_alpha) ? (
            <img src={thumbnailSrc} alt="" style={{ maxHeight: "50vh", maxWidth: "40vw" }} />
          ) : (
            <ThumbnailCanvas src={thumbnailSrc} />
          )}
        </div>,
        document.body
      )}
    </Card>
  );
});
