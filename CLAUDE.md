# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ghost Launcher is a Tauri 2 desktop application for discovering and launching Ukagaka/SSP ghosts. It scans SSP installation directories and additional custom folders, parses ghost metadata from `descript.txt` files (Shift_JIS/UTF-8), and provides a searchable launcher UI.

## Commands

```bash
# Development (starts both Vite dev server and Tauri)
npm run tauri dev

# Frontend only (Vite dev server on port 1420)
npm run dev

# Build frontend
npm run build

# Check Rust backend compilation
cd src-tauri && cargo check

# Build full application
npm run tauri build
```

## Architecture

**Tauri 2 app**: Rust backend + React 19 / TypeScript frontend.

### Backend (`src-tauri/src/`)

- `lib.rs` — Tauri app builder, registers commands and plugins (dialog, store)
- `commands/ghost.rs` — `scan_ghosts` command: scans `{ssp_path}/ghost/` and additional folders for ghost subdirectories, parses `descript.txt` metadata
- `commands/ssp.rs` — `launch_ghost` command: spawns `ssp.exe /g {ghost}` (directory name for SSP-internal ghosts, full path for external)
- `utils/descript.rs` — Parses `descript.txt` with charset detection (UTF-8 BOM → charset field → Shift_JIS fallback) using `encoding_rs`

### Frontend (`src/`)

- `hooks/useSettings.ts` — Persists `ssp_path` and `ghost_folders` via `@tauri-apps/plugin-store` (LazyStore → `settings.json`)
- `hooks/useGhosts.ts` — Invokes `scan_ghosts` Tauri command, auto-refreshes when paths change
- `hooks/useSearch.ts` — Client-side ghost filtering by name/directory_name
- `components/` — SettingsPanel (folder management), GhostList/GhostCard (display/launch), SearchBox

### Key Patterns

**Tauri command invocation**: Frontend uses `invoke()` with camelCase parameter names that auto-convert to snake_case on the Rust side (e.g., `sspPath` → `ssp_path`, `additionalFolders` → `additional_folders`).

**Ghost directory structure**: `{parent}/ghost/{ghost_name}/ghost/master/descript.txt` — the `parent` is either `{ssp_path}` (for SSP-native ghosts) or a user-specified additional folder directly containing ghost subdirectories.

## Language

All UI text is in Japanese. Code comments in Rust files are also in Japanese.
