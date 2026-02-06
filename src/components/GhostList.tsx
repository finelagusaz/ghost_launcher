import { GhostCard } from "./GhostCard";
import type { Ghost } from "../types";

interface Props {
  ghosts: Ghost[];
  sspPath: string;
  loading: boolean;
  error: string | null;
}

export function GhostList({ ghosts, sspPath, loading, error }: Props) {
  if (loading) {
    return <div className="ghost-list-message">読み込み中...</div>;
  }

  if (error) {
    return <div className="ghost-list-message ghost-list-error">{error}</div>;
  }

  if (ghosts.length === 0) {
    return <div className="ghost-list-message">ゴーストが見つかりません</div>;
  }

  return (
    <div className="ghost-list">
      <div className="ghost-count">{ghosts.length} 体のゴースト</div>
      {ghosts.map((ghost) => (
        <GhostCard key={ghost.path} ghost={ghost} sspPath={sspPath} />
      ))}
    </div>
  );
}
