use rusqlite::Connection;

/// user-data.db に起動履歴テーブルを冪等に用意する。
/// ここは sqlx マイグレーション系に載せない（永続ストアなので自動削除の事故クラスが構造上発生しない）。
pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ghost_launches (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ghost_identity_key TEXT NOT NULL,\n  launched_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_identity ON ghost_launches(ghost_identity_key);\nCREATE INDEX IF NOT EXISTS idx_ghost_launches_at ON ghost_launches(launched_at DESC);",
    )
    .map_err(|e| format!("user-data スキーマ作成エラー: {e}"))
}

/// ghosts に存在する全世代（request_key）を列挙する部分問い合わせ。
///
/// 集計列の更新は identity だけが条件だが、ghosts の index はどれも request_key 先頭のため、
/// そのままでは全表走査になる（skip-scan が選ばれるのは sqlite_stat1 があるときだけで、
/// 初回起動・リビルド直後の空 DB に PRAGMA optimize をかけても統計は作られない）。
/// 世代を先に列挙して `request_key IN (…)` を添え、UNIQUE index (request_key, ghost_identity_key)
/// の点引きに落とす。列挙は MIN の index 探索を世代数ぶん繰り返す loose index scan で、
/// 行数に依らない（`SELECT DISTINCT request_key` は index を全走査する）。
macro_rules! all_request_keys_subquery {
    () => {
        "(WITH RECURSIVE gen(k) AS (\
            SELECT MIN(request_key) FROM ghosts \
            UNION ALL \
            SELECT (SELECT MIN(request_key) FROM ghosts WHERE request_key > gen.k) \
            FROM gen WHERE gen.k IS NOT NULL\
        ) SELECT k FROM gen WHERE k IS NOT NULL)"
    };
}

/// 起動 1 回ぶんの集計列 bump（record_launch_inner が使う）。同一 identity を持つ全世代を更新する。
const BUMP_AGGREGATES_SQL: &str = concat!(
    "UPDATE ghosts SET launch_count = launch_count + 1, last_launched = datetime('now') \
     WHERE ghost_identity_key = ?1 AND request_key IN ",
    all_request_keys_subquery!()
);

/// 集計列の絶対値上書き（backfill_aggregates が使う）。同一 identity を持つ全世代を更新する。
const BACKFILL_AGGREGATES_SQL: &str = concat!(
    "UPDATE ghosts SET last_launched = ?2, launch_count = ?3 \
     WHERE ghost_identity_key = ?1 AND request_key IN ",
    all_request_keys_subquery!()
);

/// 起動履歴を記録する。user-data.db へ INSERT（権威）し、ghosts.db の集計列を bump（導出）する。
/// user-data 側を先に書くため、ghosts 側更新が失敗しても権威データは残り、次回バックフィルで整合する。
/// 呼び出し元は actor::handle_job（アクタースレッド上）。
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
        .execute(BUMP_AGGREGATES_SQL, rusqlite::params![ghost_identity_key])
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
    // 起動済みゴーストの数だけ UPDATE を発行するため、1 トランザクション・1 準備文にまとめる
    let tx = ghosts_conn
        .unchecked_transaction()
        .map_err(|e| format!("集計列バックフィル開始エラー: {e}"))?;
    {
        let mut stmt = tx
            .prepare_cached(BACKFILL_AGGREGATES_SQL)
            .map_err(|e| format!("集計列バックフィル UPDATE 準備エラー: {e}"))?;
        for (key, last, count) in aggregates {
            stmt.execute(rusqlite::params![key, last, count])
                .map_err(|e| format!("集計列バックフィル UPDATE エラー: {e}"))?;
        }
    }
    tx.commit()
        .map_err(|e| format!("集計列バックフィル commit エラー: {e}"))
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

/// 起動履歴を記録する Tauri コマンド。実体は DB アクターの RecordLaunch ジョブ（設計書 §3）。
#[tauri::command]
pub async fn record_launch(
    ghost_identity_key: String,
    actor: tauri::State<'_, crate::actor::ActorHandle>,
) -> Result<(), String> {
    actor
        .request(|reply| crate::actor::Job::RecordLaunch {
            ghost_identity_key,
            reply,
        })
        .await
}

// テストは旧世代 DB 再現・検証用に ghosts.db/user-data.db を直接開く（actor 経由と別の検証用接続）。
#[cfg(test)]
#[allow(clippy::disallowed_methods)]
mod tests {
    use super::*;
    use crate::testutil::{insert_ghost_row, insert_ghost_row_in};

    fn ghosts_conn_with_row(identity_key: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::testutil::apply_cache_schema(&conn);
        insert_ghost_row(&conn, identity_key);
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
            .query_row(
                "SELECT COUNT(*) FROM ghost_launches WHERE ghost_identity_key = 'sspg'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(launches, 2);

        let (count, last): (i64, Option<String>) = ghosts_conn
            .query_row(
                "SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspg'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
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
        insert_ghost_row_in(&ghosts_conn, "rk1", "sspb");
        // user-data に A の起動 3 回（時刻昇順）
        for at in [
            "2026-01-01 00:00:00",
            "2026-01-02 00:00:00",
            "2026-01-03 00:00:00",
        ] {
            user_conn
                .execute("INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES ('sspg', ?1)", rusqlite::params![at])
                .unwrap();
        }

        backfill_aggregates(&ghosts_conn, &user_conn).unwrap();

        let (count, last): (i64, Option<String>) = ghosts_conn
            .query_row(
                "SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspg'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(last.as_deref(), Some("2026-01-03 00:00:00"));

        let (bcount, blast): (i64, Option<String>) = ghosts_conn
            .query_row(
                "SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key = 'sspb'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(bcount, 0);
        assert_eq!(blast, None);
    }

    fn aggregates_of(
        conn: &Connection,
        request_key: &str,
        identity_key: &str,
    ) -> (i64, Option<String>) {
        conn.query_row(
            "SELECT launch_count, last_launched FROM ghosts WHERE request_key = ?1 AND ghost_identity_key = ?2",
            rusqlite::params![request_key, identity_key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    fn query_plan(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        // プランは値に依らないので、バインド変数はすべて NULL で埋める
        let nulls = vec![rusqlite::types::Null; stmt.parameter_count()];
        // 行の取得失敗を捨てると「SCAN が無い」検査が空のプランで通ってしまうため、落とす
        stmt.query_map(rusqlite::params_from_iter(nulls), |r| r.get::<_, String>(3))
            .unwrap()
            .map(|row| row.expect("EXPLAIN QUERY PLAN の detail 列を読めること"))
            .collect()
    }

    /// 集計列の更新文は identity だけを条件にすると、先頭列の合う index が無く全表走査になる
    /// （skip-scan は sqlite_stat1 があるときしか選ばれず、初回起動・リビルド直後の空 DB に
    /// PRAGMA optimize をかけても統計は作られない）。統計の無い DB でも UNIQUE index
    /// (request_key, ghost_identity_key) の点引きになることを、プランで縛る。
    #[test]
    fn 集計列の更新文は統計が無くても全表走査しない() {
        let conn = Connection::open_in_memory().unwrap();
        crate::testutil::apply_cache_schema(&conn);

        for sql in [BUMP_AGGREGATES_SQL, BACKFILL_AGGREGATES_SQL] {
            let plan = query_plan(&conn, sql);
            assert!(
                !plan.iter().any(|d| d.starts_with("SCAN ghosts")),
                "ghosts を全表走査している: {plan:?}
  sql: {sql}"
            );
            assert!(
                plan.iter()
                    .any(|d| d.contains("request_key=? AND ghost_identity_key=?")),
                "(request_key, ghost_identity_key) の点引きになっていない: {plan:?}
  sql: {sql}"
            );
        }
    }

    #[test]
    fn record_launch_innerは同一identityを持つ全世代の集計列をbumpする() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_row("sspg"); // 世代 rk1
        insert_ghost_row_in(&ghosts_conn, "rk2", "sspg");
        insert_ghost_row_in(&ghosts_conn, "rk2", "sspother");

        record_launch_inner(&user_conn, &ghosts_conn, "sspg").unwrap();

        assert_eq!(aggregates_of(&ghosts_conn, "rk1", "sspg").0, 1);
        assert_eq!(aggregates_of(&ghosts_conn, "rk2", "sspg").0, 1);
        assert_eq!(
            aggregates_of(&ghosts_conn, "rk2", "sspother"),
            (0, None),
            "別 identity は触らない"
        );
    }

    #[test]
    fn backfill_aggregatesは全世代へ書き戻しghostsに居ない履歴は無視する() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_row("sspg"); // 世代 rk1
        insert_ghost_row_in(&ghosts_conn, "rk2", "sspg");
        for (key, at) in [
            ("sspg", "2026-01-01 00:00:00"),
            ("sspg", "2026-01-02 00:00:00"),
            ("ssp-gone", "2026-01-03 00:00:00"), // ghosts に居ない（削除済みゴーストの履歴）
        ] {
            user_conn
                .execute(
                    "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, ?2)",
                    rusqlite::params![key, at],
                )
                .unwrap();
        }

        backfill_aggregates(&ghosts_conn, &user_conn).unwrap();

        let expected = (2, Some("2026-01-02 00:00:00".to_string()));
        assert_eq!(aggregates_of(&ghosts_conn, "rk1", "sspg"), expected);
        assert_eq!(aggregates_of(&ghosts_conn, "rk2", "sspg"), expected);
    }

    fn ghosts_conn_with_legacy_launches(rows: &[(&str, &str)]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // migration 11 相当の legacy テーブルのみ用意（本テストは移送だけを対象）
        conn.execute_batch(
            "CREATE TABLE ghost_launches (id INTEGER PRIMARY KEY AUTOINCREMENT, ghost_identity_key TEXT NOT NULL, launched_at TEXT NOT NULL);",
        )
        .unwrap();
        for (key, at) in rows {
            conn.execute(
                "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES (?1, ?2)",
                rusqlite::params![key, at],
            )
            .unwrap();
        }
        conn
    }

    #[test]
    fn migrate_legacyは旧履歴を複写し二度目は複写しない() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = ghosts_conn_with_legacy_launches(&[
            ("sspg", "2026-01-01 00:00:00"),
            ("sspg", "2026-01-02 00:00:00"),
        ]);

        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();
        // 冪等: 二度目は user-data が非空なので何もしない
        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();

        let total: i64 = user_conn
            .query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2, "重複複写されないこと");
    }

    #[test]
    fn migrate_legacyはlegacyテーブル不在でno_op() {
        let user_conn = Connection::open_in_memory().unwrap();
        ensure_schema(&user_conn).unwrap();
        let ghosts_conn = Connection::open_in_memory().unwrap(); // ghost_launches なし
        migrate_legacy_launch_history(&ghosts_conn, &user_conn).unwrap();
        let total: i64 = user_conn
            .query_row("SELECT COUNT(*) FROM ghost_launches", [], |r| r.get(0))
            .unwrap();
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

    // 旧世代（migration 1..=11 の ghosts.db・履歴同居）からのアップグレードで、
    // legacy 移送 → ensure_cache_schema（全 DROP リビルド）の順序により
    // 永続履歴が保持され集計へ再導出されることを検証する（設計書 §2.1/§9・issue #93/#146）。
    #[test]
    fn アップグレードのリビルドを通じて起動履歴が保持され集計へ再導出される() {
        let dir = crate::testutil::TempDirGuard::new("ghost_launcher_upgrade_rebuild_test");
        let ghosts_path = dir.path().join("ghosts.db");
        let user_path = dir.path().join("user-data.db");

        // 旧バージョン再現: v11 世代（履歴同居・user_version=0）の ghosts.db を本テストに必要な
        // 最小限で再現する（旧 migrations() は parity テスト退役と同時に削除済み。以下は
        // リリース済み旧スキーマの凍結断片で、insert_ghost_row の列と ghost_launches を含む）。
        {
            let conn = Connection::open(&ghosts_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE ghosts (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  directory_name TEXT NOT NULL,\n  path TEXT NOT NULL,\n  source TEXT NOT NULL,\n  name_lower TEXT NOT NULL,\n  directory_name_lower TEXT NOT NULL,\n  request_key TEXT NOT NULL DEFAULT '',\n  updated_at TEXT NOT NULL DEFAULT '',\n  craftman TEXT NOT NULL DEFAULT '',\n  thumbnail_path TEXT NOT NULL DEFAULT '',\n  thumbnail_use_self_alpha INTEGER NOT NULL DEFAULT 0,\n  thumbnail_kind TEXT NOT NULL DEFAULT '',\n  ghost_identity_key TEXT NOT NULL DEFAULT '',\n  row_fingerprint TEXT NOT NULL DEFAULT '',\n  sakura_name TEXT NOT NULL DEFAULT '',\n  kero_name TEXT NOT NULL DEFAULT '',\n  craftmanw TEXT NOT NULL DEFAULT '',\n  sakura_name_lower TEXT NOT NULL DEFAULT '',\n  kero_name_lower TEXT NOT NULL DEFAULT '',\n  craftman_lower TEXT NOT NULL DEFAULT '',\n  craftmanw_lower TEXT NOT NULL DEFAULT ''\n);\nCREATE TABLE ghost_launches (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ghost_identity_key TEXT NOT NULL,\n  launched_at TEXT NOT NULL\n);",
            )
            .unwrap();
            insert_ghost_row(&conn, "sspg");
            for at in ["2026-01-01 00:00:00", "2026-01-02 00:00:00"] {
                conn.execute(
                    "INSERT INTO ghost_launches (ghost_identity_key, launched_at) VALUES ('sspg', ?1)",
                    rusqlite::params![at],
                )
                .unwrap();
            }
        }

        // 起動シーケンス（設計書 §2.1 の順序）: (2) legacy 移送 → (3) リビルド
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
        {
            let mut conn = Connection::open(&ghosts_path).unwrap();
            crate::cache_schema::ensure_cache_schema(&mut conn).unwrap(); // user_version=0 → 全 DROP リビルド
            let has_legacy: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ghost_launches'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                has_legacy, 0,
                "リビルドで旧テーブルは消える（移送済みなので安全）"
            );
        }

        // 再スキャン相当: 行再投入 + backfill → 集計が移送済み履歴から復元される
        {
            let conn = Connection::open(&ghosts_path).unwrap();
            insert_ghost_row(&conn, "sspg");
            let user_conn = Connection::open(&user_path).unwrap();
            backfill_aggregates(&conn, &user_conn).unwrap();
            let (c, last): (i64, Option<String>) = conn
                .query_row(
                    "SELECT launch_count, last_launched FROM ghosts WHERE ghost_identity_key='sspg'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(c, 2, "リビルド後も user-data.db の履歴から集計が復元される");
            assert_eq!(last.as_deref(), Some("2026-01-02 00:00:00"));
        }
    }
}
