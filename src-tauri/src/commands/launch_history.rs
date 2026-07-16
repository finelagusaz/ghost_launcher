use rusqlite::Connection;
use tauri::Manager;

/// user-data.db に起動履歴テーブルを冪等に用意する。
/// ここは sqlx マイグレーション系に載せない（永続ストアなので自動削除の事故クラスが構造上発生しない）。
pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ghost_launches (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ghost_identity_key TEXT NOT NULL,\n  launched_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_identity ON ghost_launches(ghost_identity_key);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_at ON ghost_launches(launched_at DESC);",
    )
    .map_err(|e| format!("user-data スキーマ作成エラー: {e}"))
}

/// user-data.db を開き、書込用 PRAGMA を適用し、スキーマを用意して返す。
pub(crate) fn open_user_data_db<R: tauri::Runtime>(
    manager: &impl Manager<R>,
) -> Result<Connection, String> {
    let path = crate::db_path::user_data_db_path(manager)?;
    let conn = Connection::open(&path).map_err(|e| format!("user-data.db オープンエラー: {e}"))?;
    crate::commands::ghost::store::configure_connection(&conn)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

/// 起動履歴を記録する。user-data.db へ INSERT（権威）し、ghosts.db の集計列を bump（導出）する。
/// user-data 側を先に書くため、ghosts 側更新が失敗しても権威データは残り、次回バックフィルで整合する。
pub(crate) fn record_launch_inner(
    user_conn: &Connection,
    ghosts_conn: &Connection,
    ghost_identity_key: &str,
) -> Result<(), String> {
    user_conn
        .execute(
            "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, datetime('now'))",
            rusqlite::params![ghost_identity_key],
        )
        .map_err(|e| format!("起動履歴 INSERT エラー: {e}"))?;
    ghosts_conn
        .execute(
            "UPDATE ghosts SET launch_count = launch_count + 1, last_launched = datetime('now') WHERE ghost_identity_key = ?1",
            rusqlite::params![ghost_identity_key],
        )
        .map_err(|e| format!("集計列 UPDATE エラー: {e}"))?;
    Ok(())
}

/// user-data.db の起動履歴集計（identity 毎の MAX(launched_at) と COUNT）を
/// ghosts.db の集計列へ書き戻す。キャッシュ再構築（cache miss）の後に呼ぶ。
/// COUNT は単調増加のため、起動済みキーだけを上書きすれば未起動行は 0/NULL のまま残る。
pub(crate) fn backfill_aggregates(
    ghosts_conn: &Connection,
    user_conn: &Connection,
) -> Result<(), String> {
    let aggregates: Vec<(String, String, i64)> = {
        let mut stmt = user_conn
            .prepare("SELECT ghost_identity_key, MAX(launched_at), COUNT(*) FROM ghost_launches GROUP BY ghost_identity_key")
            .map_err(|e| format!("集計 SELECT 準備エラー: {e}"))?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| format!("集計 SELECT エラー: {e}"))?
            .filter_map(Result::ok)
            .collect()
    };
    for (key, last, count) in aggregates {
        ghosts_conn
            .execute(
                "UPDATE ghosts SET last_launched = ?2, launch_count = ?3 WHERE ghost_identity_key = ?1",
                rusqlite::params![key, last, count],
            )
            .map_err(|e| format!("集計列バックフィル UPDATE エラー: {e}"))?;
    }
    Ok(())
}

/// 旧 ghosts.db.ghost_launches の履歴を user-data.db へ一度だけ複写する。
/// 冪等ガード = user-data.db が空のときだけ複写する（二重複写を防ぐ）。
/// このため migration 13 による旧テーブル DROP の順序に依存せず安全。
pub(crate) fn migrate_legacy_launch_history(
    ghosts_conn: &Connection,
    user_conn: &Connection,
) -> Result<(), String> {
    let already: i64 = user_conn
        .query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0))
        .unwrap_or(0);
    if already > 0 {
        return Ok(());
    }
    let has_legacy: i64 = ghosts_conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'ghost_launches'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_legacy == 0 {
        return Ok(());
    }
    let legacy: Vec<(String, String)> = {
        let mut stmt = ghosts_conn
            .prepare("SELECT ghost_identity_key, launched_at FROM ghost_launches")
            .map_err(|e| format!("legacy SELECT 準備エラー: {e}"))?;
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| format!("legacy SELECT エラー: {e}"))?
            .filter_map(Result::ok)
            .collect()
    };
    for (key, at) in legacy {
        user_conn
            .execute(
                "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, ?2)",
                rusqlite::params![key, at],
            )
            .map_err(|e| format!("legacy 移送 INSERT エラー: {e}"))?;
    }
    Ok(())
}

/// 起動履歴を記録する Tauri コマンド。user-data.db へ INSERT し ghosts.db の集計列を bump する。
/// scan/reset と同一の ScanCoordinator ロックで直列化する: backfill は「user-data SELECT →
/// ghosts へ絶対値 UPDATE」の read-modify-write であり、その間に本コマンドの相対 bump（+1）が
/// 割り込むと集計列が古い絶対値で巻き戻る（lost update）。SQLite WAL の文単位直列化では防げない。
/// 別スレッド実行のためメインスレッドはロック待ちで固まらない。
/// `<R>` はテストで `MockRuntime` を渡せるようにするためのランタイム総称化（本番は `Wry` に推論）。
#[tauri::command]
pub async fn record_launch<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ghost_identity_key: String,
    coordinator: tauri::State<'_, crate::scan_coordinator::ScanCoordinator>,
) -> Result<(), String> {
    coordinator
        .run_serialized("起動履歴タスク", move || {
            let user_conn = open_user_data_db(&app)?;
            let ghosts_path = crate::db_path::ghost_db_path(&app)?;
            let ghosts_conn = Connection::open(&ghosts_path)
                .map_err(|e| format!("ghosts.db オープンエラー: {e}"))?;
            crate::commands::ghost::store::configure_connection(&ghosts_conn)?;
            record_launch_inner(&user_conn, &ghosts_conn, &ghost_identity_key)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ghosts_conn_with_row(identity_key: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let mut migs = crate::migrations();
        migs.sort_by_key(|m| m.version);
        for m in migs {
            conn.execute_batch(m.sql).unwrap();
        }
        conn.execute(
            "INSERT INTO ghosts (request_key, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES ('rk1', ?1, '', 'G', '', '', '', '', 'g', '/g', 'ssp', 'g', '', '', '', '', 'g', '', 0, '', '')",
            rusqlite::params![identity_key],
        )
        .unwrap();
        conn
    }

    #[test]
    fn record_launch_innerはuserdataへinsertしghostsの集計列をbumpする() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_row("sspg");

        record_launch_inner(&user_conn, &ghosts_conn, "sspg").unwrap();
        record_launch_inner(&user_conn, &ghosts_conn, "sspg").unwrap();

        let launches: i64 = user_conn
            .query_row("SELECT COUNT(*) FROM ghost_launches WHERE ghost_identity_key = 'sspg'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(launches, 2);

        let (count, last): (i64, Option<String>) = ghosts_conn
            .query_row("SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspg'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(count, 2);
        assert!(last.is_some(), "last_launched が設定されること");
    }

    #[test]
    fn backfill_aggregatesはuserdataの集計をghostsへ再導出する() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_row("sspg");
        // 未起動の別ゴースト B も用意（0/NULL のままであること）
        ghosts_conn
            .execute(
                "INSERT INTO ghosts (request_key, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES ('rk1', 'sspb', '', 'B', '', '', '', '', 'b', '/b', 'ssp', 'b', '', '', '', '', 'b', '', 0, '', '')",
                [],
            )
            .unwrap();
        // user-data に A の起動 3 回（時刻昇順）
        for at in ["2026-01-01 00:00:00", "2026-01-02 00:00:00", "2026-01-03 00:00:00"] {
            user_conn
                .execute("INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES ('sspg', ?1)", rusqlite::params![at])
                .unwrap();
        }

        backfill_aggregates(&ghosts_conn, &user_conn).unwrap();

        let (count, last): (i64, Option<String>) = ghosts_conn
            .query_row("SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspg'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(last.as_deref(), Some("2026-01-03 00:00:00"));

        let (bcount, blast): (i64, Option<String>) = ghosts_conn
            .query_row("SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspb'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(bcount, 0);
        assert_eq!(blast, None);
    }

    fn ghosts_conn_with_legacy_launches(rows: &[(&str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // migration 11 相当の legacy テーブルのみ用意（本テストは移送だけを対象）
        conn.execute_batch(
            "CREATE TABLE ghost_launches (id INTEGER PRIMARY KEY AUTOINCREMENT, ghost_identity_key TEXT NOT NULL, launched_at TEXT NOT NULL);",
        )
        .unwrap();
        for (key, at) in rows {
            conn.execute("INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, ?2)", rusqlite::params![key, at]).unwrap();
        }
        conn
    }

    #[test]
    fn migrate_legacyは旧履歴を複写し二度目は複写しない() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_legacy_launches(&[("sspg", "2026-01-01 00:00:00"), ("sspg", "2026-01-02 00:00:00")]);

        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();
        // 冪等: 二度目は user-data が非空なので何もしない
        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();

        let total: i64 = user_conn.query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 2, "重複複写されないこと");
    }

    #[test]
    fn migrate_legacyはlegacyテーブル不在でno_op() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = Connection::open_in_memory().unwrap(); // ghost_launches なし
        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();
        let total: i64 = user_conn.query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 0);
    }

    #[test]
    fn ensure_schemaはghost_launchesテーブルを冪等に作る() {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        // 二重呼び出しでも失敗しない（IF NOT EXISTS）
        ensure_schema(&conn).unwrap();

        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(ghost_launches)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(cols.contains(&"ghost_identity_key".to_string()));
        assert!(cols.contains(&"launched_at".to_string()));
    }

    fn insert_ghost_row(conn: &Connection, identity_key: &str) {
        conn.execute(
            "INSERT INTO ghosts (request_key, ghost_identity_key, row_fingerprint, name, sakura_name, kero_name, craftman, craftmanw, directory_name, path, source, name_lower, sakura_name_lower, kero_name_lower, craftman_lower, craftmanw_lower, directory_name_lower, thumbnail_path, thumbnail_use_self_alpha, thumbnail_kind, updated_at) VALUES ('rk1', ?1, '', 'G', '', '', '', '', 'g', '/g', 'ssp', 'g', '', '', '', '', 'g', '', 0, '', '')",
            rusqlite::params![identity_key],
        )
        .unwrap();
    }

    // アップグレード（旧 ghosts.db に同居した履歴）とリセット（ghosts.db 削除）を
    // 実ファイル DB で通し、issue #93 の不変条件「キャッシュのリセットは永続履歴を失わせない」を
    // end-to-end で検証する。setup 移送 → migration 12/13 → スキャン backfill → リセット → 再スキャンの順。
    #[test]
    fn アップグレードとリセットを通じて起動履歴が保持され集計へ再導出される() {
        let dir = crate::testutil::TempDirGuard::new("ghost_launcher_upgrade_reset_test");
        let ghosts_path = dir.path().join("ghosts.db");
        let user_path = dir.path().join("user-data.db");

        // 旧バージョン再現: migration 1..=11 のみ適用し、ghost 行 + 起動履歴 2 件を投入
        {
            let conn = Connection::open(&ghosts_path).unwrap();
            let mut migs = crate::migrations();
            migs.sort_by_key(|m| m.version);
            for m in migs.iter().filter(|m| m.version <= 11) {
                conn.execute_batch(m.sql).unwrap();
            }
            insert_ghost_row(&conn, "sspg");
            for at in ["2026-01-01 00:00:00", "2026-01-02 00:00:00"] {
                conn.execute(
                    "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES ('sspg', ?1)",
                    rusqlite::params![at],
                )
                .unwrap();
            }
        }

        // アップグレード setup 相当: user-data 初期化 + legacy 移送（JS の migration DROP より前に走る）
        {
            let user_conn = Connection::open(&user_path).unwrap();
            ensure_schema(&user_conn).unwrap();
            let ghosts_conn = Connection::open(&ghosts_path).unwrap();
            migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();
            let n: i64 = user_conn
                .query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 2, "旧履歴が user-data.db へ移送される");
        }

        // JS の Database.load 相当: migration 12/13（集計列追加 + 旧テーブル DROP）
        {
            let conn = Connection::open(&ghosts_path).unwrap();
            let mut migs = crate::migrations();
            migs.sort_by_key(|m| m.version);
            for m in migs.iter().filter(|m| m.version >= 12) {
                conn.execute_batch(m.sql).unwrap();
            }
            let has: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ghost_launches'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has, 0, "旧 ghost_launches は ghosts.db から除去される");
        }

        // スキャン相当: backfill で集計列へ再導出（アップグレード後の recent/frequency 復元）
        {
            let ghosts_conn = Connection::open(&ghosts_path).unwrap();
            let user_conn = Connection::open(&user_path).unwrap();
            backfill_aggregates(&ghosts_conn, &user_conn).unwrap();
            let (c, last): (i64, Option<String>) = ghosts_conn
                .query_row(
                    "SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key='sspg'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(c, 2, "アップグレード後、集計列が移送済み履歴から復元される");
            assert_eq!(last.as_deref(), Some("2026-01-02 00:00:00"));
        }

        // リセット相当: ghosts.db を削除、user-data.db は残す
        std::fs::remove_file(&ghosts_path).unwrap();
        assert!(user_path.exists(), "user-data.db はリセット対象外で残存する");

        // リセット後の再スキャン: ghosts.db を全 migration で再作成 + 行再投入 + backfill
        {
            let conn = Connection::open(&ghosts_path).unwrap();
            let mut migs = crate::migrations();
            migs.sort_by_key(|m| m.version);
            for m in migs {
                conn.execute_batch(m.sql).unwrap();
            }
            insert_ghost_row(&conn, "sspg");
            let user_conn = Connection::open(&user_path).unwrap();
            backfill_aggregates(&conn, &user_conn).unwrap();
            let c: i64 = conn
                .query_row(
                    "SELECT launch_count FROM ghosts WHERE ghost_identity_key='sspg'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(c, 2, "リセット後も user-data.db の履歴から集計が復元される（#93 の核心）");
        }
    }
}
