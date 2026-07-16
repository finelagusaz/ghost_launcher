import { useTranslation } from "react-i18next";
import { ProgressBar, makeStyles } from "@fluentui/react-components";

interface Props {
  visible: boolean;
}

const useStyles = makeStyles({
  // レイアウトシフト回避: 常に 2px のトラック高を確保し、idle 時は空（透明）にする
  track: {
    height: "2px",
  },
});

/**
 * 再スキャン中の非確定インジケータ（AppHeader 直下の細いバー）。表示専用。
 * value を渡さないため Fluent ProgressBar は非確定（indeterminate）として描画される。
 * visible=false でも 2px のトラックを保持し、出現/消滅でレイアウトが揺れないようにする。
 */
export function ScanProgressBar({ visible }: Props) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <div className={styles.track} data-testid="scan-progress-track">
      {visible && <ProgressBar aria-label={t("list.scanning")} />}
    </div>
  );
}
