import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Ghost } from "../types";

interface Props {
  ghost: Ghost;
  sspPath: string;
}

function getSourceFolderLabel(source: string): string {
  return source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || source;
}

export function GhostCard({ ghost, sspPath }: Props) {
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
    <div className="ghost-card">
      <div className="ghost-info">
        <span className="ghost-name">{ghost.name}</span>
        <span className="ghost-dir">
          {ghost.directory_name}
          {sourceFolderLabel && (
            <span className="ghost-source-badge">({sourceFolderLabel})</span>
          )}
        </span>
      </div>
      <div className="ghost-actions">
        <button
          className="btn btn-primary"
          onClick={handleLaunch}
          disabled={launching}
        >
          {launching ? "起動中..." : "起動"}
        </button>
      </div>
      {error && <div className="ghost-error">{error}</div>}
    </div>
  );
}
