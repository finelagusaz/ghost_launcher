import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Ghost } from "../types";

interface Props {
  ghost: Ghost;
  sspPath: string;
}

export function GhostCard({ ghost, sspPath }: Props) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLaunch = async () => {
    setLaunching(true);
    setError(null);
    try {
      await invoke("launch_ghost", {
        sspPath,
        ghostDirectoryName: ghost.directory_name,
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
        <span className="ghost-dir">{ghost.directory_name}</span>
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
