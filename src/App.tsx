import { useEffect, useState } from "react";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const filteredGhosts = useSearch(ghosts, searchQuery);

  useEffect(() => {
    if (!settingsLoading && !sspPath) {
      setSettingsOpen(true);
    }
  }, [settingsLoading, sspPath]);

  if (settingsLoading) {
    return <div className="app-loading">読み込み中...</div>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Ghost Launcher</h1>
        <div className="header-actions">
          <button
            className="btn btn-secondary settings-trigger"
            onClick={() => setSettingsOpen(true)}
          >
            <svg
              className="settings-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.13.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.4 1.05.71 1.63.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.23 1.13-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.2A3.2 3.2 0 1 1 12 8.8a3.2 3.2 0 0 1 0 6.4Z"
              />
            </svg>
            設定
          </button>
        </div>
      </header>

      {settingsOpen && (
        <div className="settings-modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <h2>設定</h2>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => setSettingsOpen(false)}
              >
                閉じる
              </button>
            </div>
            <SettingsPanel
              sspPath={sspPath}
              onPathChange={saveSspPath}
              ghostFolders={ghostFolders}
              onAddFolder={addGhostFolder}
              onRemoveFolder={removeGhostFolder}
            />
          </div>
        </div>
      )}

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
