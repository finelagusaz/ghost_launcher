import { useState } from "react";
import { useSettings } from "./hooks/useSettings";
import { useGhosts } from "./hooks/useGhosts";
import { useSearch } from "./hooks/useSearch";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchBox } from "./components/SearchBox";
import { GhostList } from "./components/GhostList";

function App() {
  const {
    sspPath,
    saveSspPath,
    ghostFolders,
    addGhostFolder,
    removeGhostFolder,
    loading: settingsLoading,
  } = useSettings();
  const { ghosts, loading: ghostsLoading, error, refresh } = useGhosts(sspPath, ghostFolders);
  const [searchQuery, setSearchQuery] = useState("");
  const filteredGhosts = useSearch(ghosts, searchQuery);

  if (settingsLoading) {
    return <div className="app-loading">読み込み中...</div>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Ghost Launcher</h1>
      </header>

      <SettingsPanel
        sspPath={sspPath}
        onPathChange={saveSspPath}
        ghostFolders={ghostFolders}
        onAddFolder={addGhostFolder}
        onRemoveFolder={removeGhostFolder}
      />

      {sspPath && (
        <>
          <div className="toolbar">
            <SearchBox value={searchQuery} onChange={setSearchQuery} />
            <button className="btn btn-secondary" onClick={refresh} disabled={ghostsLoading}>
              再読込
            </button>
          </div>
          <GhostList
            ghosts={filteredGhosts}
            sspPath={sspPath}
            loading={ghostsLoading}
            error={error}
          />
        </>
      )}

      {!sspPath && (
        <div className="ghost-list-message">
          SSPフォルダを選択してください
        </div>
      )}
    </div>
  );
}

export default App;
