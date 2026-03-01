import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  overlay: {
    position: "fixed",
    pointerEvents: "none" as const,
    zIndex: 10000,
    animationName: {
      from: { opacity: 0 },
      to: { opacity: 1 },
    },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveEasyEase,
    animationFillMode: "forwards",
    boxShadow: tokens.shadow16,
  },
  thumbnailRounded: {
    borderRadius: tokens.borderRadiusXLarge,
  },
});

const overlayMaxSize: React.CSSProperties = { maxHeight: "50vh", maxWidth: "40vw" };

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
const ThumbnailCanvas = memo(function ThumbnailCanvas({ src, className }: { src: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
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
    return () => { cancelled = true; };
  }, [src]);
  return <canvas ref={canvasRef} className={className} style={overlayMaxSize} />;
});

export const GhostCard = memo(function GhostCard({ ghost, sspPath }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceFolderLabel = ghost.source !== "ssp" ? getSourceFolderLabel(ghost.source) : null;

  const handleMouseEnter = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => setShowOverlay(true), 150);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setShowOverlay(false);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

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

  const overlayPositionStyle: React.CSSProperties = {
    bottom: ghost.thumbnail_kind === "surface" ? 0 : "20px",
    right: ghost.thumbnail_kind === "surface" ? 0 : "20px",
  };

  const shouldRoundCorners = ghost.thumbnail_kind !== "surface";
  const roundedClass = shouldRoundCorners ? styles.thumbnailRounded : undefined;

  return (
    <Card
      className={styles.card}
      appearance="outline"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
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
      {showOverlay && thumbnailSrc && createPortal(
        <div className={styles.overlay} style={overlayPositionStyle}>
          {Boolean(ghost.thumbnail_use_self_alpha) ? (
            <img src={thumbnailSrc} alt="" className={roundedClass} style={overlayMaxSize} />
          ) : (
            <ThumbnailCanvas src={thumbnailSrc} className={roundedClass} />
          )}
        </div>,
        document.body
      )}
    </Card>
  );
});
