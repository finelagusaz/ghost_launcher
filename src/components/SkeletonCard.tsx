import { memo } from "react";
import { Skeleton, SkeletonItem, makeStyles, tokens } from "@fluentui/react-components";

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
    height: "100px",
    boxSizing: "border-box",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "16px",
    alignItems: "center",
  },
  info: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
});

export const SkeletonCard = memo(function SkeletonCard() {
  const styles = useStyles();

  return (
    <div className={styles.card}>
      <Skeleton>
        <div className={styles.row}>
          <div className={styles.info}>
            <SkeletonItem size={16} style={{ width: "60%" }} />
            <SkeletonItem size={12} style={{ width: "40%" }} />
          </div>
          <SkeletonItem size={32} style={{ width: "64px" }} />
        </div>
      </Skeleton>
    </div>
  );
});
