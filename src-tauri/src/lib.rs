use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(not(debug_assertions))]
use std::{
    net::{TcpListener, TcpStream},
    process::Stdio,
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
    Column, Connection, Row, SqliteConnection, TypeInfo, ValueRef,
};
use tauri::{Manager, WebviewUrl};

const KEYCHAIN_SERVICE: &str = "com.bezgrow.erp";
const LOCAL_DATABASE_NAME: &str = "bezgrow-offline.db";
#[cfg(not(debug_assertions))]
const DESKTOP_SERVER_PORT: u16 = 43124;

struct NextServerState(Mutex<Option<Child>>);

fn stop_next_server<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(state) = app.try_state::<NextServerState>() else {
        return;
    };

    let Some(mut child) = state.0.lock().expect("next server state poisoned").take() else {
        return;
    };

    let _ = child.kill();
    let _ = child.wait();
}

fn startup_log_path(app: &tauri::App) -> PathBuf {
    app.path()
        .app_log_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir().join("Bezgrow"))
        .join("bezgrow-startup.log")
}

fn append_startup_log(app: &tauri::App, message: impl AsRef<str>) {
    let path = startup_log_path(app);

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown-time".to_string());

    let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
}

#[tauri::command]
fn desktop_startup_log<R: tauri::Runtime>(app: tauri::AppHandle<R>, message: String) {
    let sanitized = message.replace(['\r', '\n'], " ");
    append_startup_log_handle(&app, sanitized);
}

fn append_startup_log_handle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    message: impl AsRef<str>,
) {
    let path = app
        .path()
        .app_log_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir().join("Bezgrow"))
        .join("bezgrow-startup.log");

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };

    let timestamp = unix_timestamp();
    let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
}

fn create_startup_error_window(
    app: &mut tauri::App,
    startup_error: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let log_path = startup_log_path(app);
    let diagnostics = serde_json::json!({
        "message": startup_error,
        "logPath": log_path.to_string_lossy(),
    })
    .to_string();

    tauri::WebviewWindowBuilder::new(
        app,
        "startup-error",
        WebviewUrl::App("startup-error.html".into()),
    )
    .title("Bezgrow ERP")
    .inner_size(760.0, 520.0)
    .min_inner_size(640.0, 420.0)
    .resizable(true)
    .initialization_script(format!("window.__BEZGROW_STARTUP_ERROR__ = {diagnostics};"))
    .build()?;

    Ok(())
}

fn keychain_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDatabaseDiagnostics {
    app_config_dir: String,
    app_data_dir: String,
    database_path: String,
    parent_exists: bool,
    parent_created: bool,
    parent_writable: bool,
    database_exists: bool,
    database_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDatabaseBackup {
    backup_path: String,
    checksum_sha256: String,
    bytes: u64,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSqlStatement {
    query: String,
    #[serde(default)]
    bind_values: Vec<serde_json::Value>,
    #[serde(default)]
    ignore_duplicate_column: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTransactionResult {
    statements: usize,
    rows_affected: u64,
}

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown-time".to_string())
}

fn local_database_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(LOCAL_DATABASE_NAME))
        .map_err(|error| format!("Unable to resolve desktop app data directory: {error}"))
}

fn sha256_file(path: &PathBuf) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Unable to open backup for checksum: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let bytes = file
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read backup for checksum: {error}"))?;
        if bytes == 0 {
            break;
        }
        hasher.update(&buffer[..bytes]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
fn desktop_database_diagnostics<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<DesktopDatabaseDiagnostics, String> {
    append_startup_log_handle(&app, "SQLite native diagnostics invoked");
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Unable to resolve desktop app config directory: {error}"))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve desktop app data directory: {error}"))?;
    let database_path = app_config_dir.join(LOCAL_DATABASE_NAME);
    let parent_existed = app_config_dir.exists();

    fs::create_dir_all(&app_config_dir)
        .map_err(|error| format!("Unable to create desktop database directory: {error}"))?;

    let probe_path = app_config_dir.join(".bezgrow-write-probe");
    let parent_writable = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe_path)
        .and_then(|mut file| file.write_all(b"ok"))
        .is_ok();
    let _ = fs::remove_file(&probe_path);

    let metadata = fs::metadata(&database_path).ok();

    Ok(DesktopDatabaseDiagnostics {
        app_config_dir: app_config_dir.to_string_lossy().to_string(),
        app_data_dir: app_data_dir.to_string_lossy().to_string(),
        database_path: database_path.to_string_lossy().to_string(),
        parent_exists: app_config_dir.exists(),
        parent_created: !parent_existed && app_config_dir.exists(),
        parent_writable,
        database_exists: metadata.is_some(),
        database_bytes: metadata.map(|value| value.len()).unwrap_or(0),
    })
}

#[tauri::command]
fn desktop_database_backup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    reason: Option<String>,
) -> Result<Option<DesktopDatabaseBackup>, String> {
    let database_path = local_database_path(&app)?;
    if !database_path.exists() {
        return Ok(None);
    }

    let parent = database_path
        .parent()
        .ok_or_else(|| "Desktop database parent directory could not be resolved.".to_string())?;
    let backup_dir = parent.join("backups");
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Unable to create desktop backup directory: {error}"))?;

    let safe_reason = reason
        .unwrap_or_else(|| "migration".to_string())
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    let created_at = unix_timestamp();
    let backup_path = backup_dir.join(format!(
        "bezgrow-offline-{}-{}.db",
        safe_reason.trim_matches('-'),
        created_at
    ));

    fs::copy(&database_path, &backup_path)
        .map_err(|error| format!("Unable to create desktop database backup: {error}"))?;
    let metadata = fs::metadata(&backup_path)
        .map_err(|error| format!("Unable to inspect desktop database backup: {error}"))?;
    let checksum_sha256 = sha256_file(&backup_path)?;

    Ok(Some(DesktopDatabaseBackup {
        backup_path: backup_path.to_string_lossy().to_string(),
        checksum_sha256,
        bytes: metadata.len(),
        created_at,
    }))
}

fn statement_preview(query: &str) -> String {
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}

async fn execute_desktop_statement(
    connection: &mut SqliteConnection,
    statement: &DesktopSqlStatement,
) -> Result<u64, String> {
    let mut query = sqlx::query(&statement.query);
    for value in &statement.bind_values {
        query = match value {
            serde_json::Value::Null => query.bind(Option::<String>::None),
            serde_json::Value::Bool(value) => query.bind(i64::from(*value)),
            serde_json::Value::Number(value) => {
                if let Some(value) = value.as_i64() {
                    query.bind(value)
                } else if let Some(value) = value.as_u64() {
                    let value = i64::try_from(value)
                        .map_err(|_| "SQLite integer bind value is out of range.".to_string())?;
                    query.bind(value)
                } else if let Some(value) = value.as_f64() {
                    query.bind(value)
                } else {
                    return Err("SQLite numeric bind value is invalid.".to_string());
                }
            }
            serde_json::Value::String(value) => query.bind(value),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                return Err("SQLite transaction bind values must be scalar.".to_string());
            }
        };
    }

    query
        .execute(&mut *connection)
        .await
        .map(|result| result.rows_affected())
        .map_err(|error| error.to_string())
}

fn sqlite_row_value(
    row: &sqlx::sqlite::SqliteRow,
    index: usize,
) -> Result<serde_json::Value, String> {
    let raw = row
        .try_get_raw(index)
        .map_err(|error| format!("Unable to inspect SQLite result column {index}: {error}"))?;
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }

    let type_name = raw.type_info().name().to_ascii_uppercase();
    match type_name.as_str() {
        "INTEGER" | "INT" => row
            .try_get::<i64, _>(index)
            .map(serde_json::Value::from)
            .map_err(|error| format!("Unable to decode SQLite integer column {index}: {error}")),
        "REAL" | "FLOAT" | "DOUBLE" | "NUMERIC" => row
            .try_get::<f64, _>(index)
            .map(serde_json::Value::from)
            .map_err(|error| format!("Unable to decode SQLite real column {index}: {error}")),
        "BLOB" => row
            .try_get::<Vec<u8>, _>(index)
            .map(|bytes| {
                serde_json::Value::Array(
                    bytes
                        .into_iter()
                        .map(|byte| serde_json::Value::from(u64::from(byte)))
                        .collect(),
                )
            })
            .map_err(|error| format!("Unable to decode SQLite blob column {index}: {error}")),
        _ => row
            .try_get::<String, _>(index)
            .map(serde_json::Value::from)
            .map_err(|error| format!("Unable to decode SQLite text column {index}: {error}")),
    }
}

async fn select_at_path(
    database_path: &Path,
    statement: &DesktopSqlStatement,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| {
            format!("Unable to open the authoritative desktop SQLite database for a read: {error}")
        })?;

    let mut query = sqlx::query(&statement.query);
    for value in &statement.bind_values {
        query = match value {
            serde_json::Value::Null => query.bind(Option::<String>::None),
            serde_json::Value::Bool(value) => query.bind(i64::from(*value)),
            serde_json::Value::Number(value) => {
                if let Some(value) = value.as_i64() {
                    query.bind(value)
                } else if let Some(value) = value.as_u64() {
                    let value = i64::try_from(value)
                        .map_err(|_| "SQLite integer bind value is out of range.".to_string())?;
                    query.bind(value)
                } else if let Some(value) = value.as_f64() {
                    query.bind(value)
                } else {
                    return Err("SQLite numeric bind value is invalid.".to_string());
                }
            }
            serde_json::Value::String(value) => query.bind(value),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                return Err("SQLite read bind values must be scalar.".to_string());
            }
        };
    }

    let rows = query.fetch_all(&mut connection).await.map_err(|error| {
        format!(
            "SQLite read failed ({}): {}",
            statement_preview(&statement.query),
            error
        )
    })?;
    rows.into_iter()
        .map(|row| {
            let mut result = serde_json::Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                result.insert(column.name().to_string(), sqlite_row_value(&row, index)?);
            }
            Ok(result)
        })
        .collect()
}

#[tauri::command]
async fn desktop_select<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    statement: DesktopSqlStatement,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let database_path = local_database_path(&app)?;
    match select_at_path(&database_path, &statement).await {
        Ok(rows) => Ok(rows),
        Err(error) => {
            append_startup_log_handle(
                &app,
                format!(
                    "SQLite native read failed: {}",
                    error.replace(['\r', '\n'], " ")
                ),
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn desktop_execute_transaction<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    statements: Vec<DesktopSqlStatement>,
) -> Result<DesktopTransactionResult, String> {
    let database_path = local_database_path(&app)?;
    match execute_transaction_at_path(&database_path, &statements).await {
        Ok(result) => Ok(result),
        Err(error) => {
            append_startup_log_handle(
                &app,
                format!(
                    "SQLite native transaction failed and was rolled back: {}",
                    error.replace(['\r', '\n'], " ")
                ),
            );
            Err(error)
        }
    }
}

async fn execute_transaction_at_path(
    database_path: &Path,
    statements: &[DesktopSqlStatement],
) -> Result<DesktopTransactionResult, String> {
    if statements.is_empty() {
        return Ok(DesktopTransactionResult {
            statements: 0,
            rows_affected: 0,
        });
    }

    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the authoritative desktop SQLite database for a transaction: {error}"))?;

    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| {
            format!("Unable to begin the authoritative desktop SQLite transaction: {error}")
        })?;
    if let Err(error) = sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut connection)
        .await
    {
        let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
        return Err(format!(
            "Unable to defer desktop SQLite foreign-key checks; the transaction was rolled back: {error}"
        ));
    }

    let mut rows_affected = 0_u64;
    for (index, statement) in statements.iter().enumerate() {
        match execute_desktop_statement(&mut connection, statement).await {
            Ok(affected) => rows_affected += affected,
            Err(error)
                if statement.ignore_duplicate_column
                    && error.to_ascii_lowercase().contains("duplicate column name") =>
            {
                continue;
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
                let preview = statement_preview(&statement.query);
                return Err(format!(
                    "SQLite transaction statement {} failed ({}): {}",
                    index + 1,
                    preview,
                    error
                ));
            }
        }
    }

    if let Err(error) = sqlx::query("COMMIT").execute(&mut connection).await {
        let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
        return Err(format!(
            "Unable to commit the authoritative desktop SQLite transaction; all statements were rolled back: {error}"
        ));
    }

    Ok(DesktopTransactionResult {
        statements: statements.len(),
        rows_affected,
    })
}

#[cfg(test)]
mod database_transaction_tests {
    use super::*;

    fn statement(query: &str, bind_values: Vec<serde_json::Value>) -> DesktopSqlStatement {
        DesktopSqlStatement {
            query: query.to_string(),
            bind_values,
            ignore_duplicate_column: false,
        }
    }

    #[test]
    fn native_batch_commits_and_rolls_back_on_one_connection() {
        let database_path = std::env::temp_dir().join(format!(
            "bezgrow-native-transaction-{}-{}.db",
            std::process::id(),
            unix_timestamp()
        ));

        tauri::async_runtime::block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("create transaction fixture");
            sqlx::query("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
                .execute(&mut connection)
                .await
                .expect("create fixture table");
            sqlx::query(
                "CREATE TABLE references_record (
                    id INTEGER PRIMARY KEY,
                    record_id INTEGER NOT NULL REFERENCES records(id)
                )",
            )
            .execute(&mut connection)
            .await
            .expect("create foreign-key fixture table");
            sqlx::query("INSERT INTO records (id, value) VALUES (10, 'referenced')")
                .execute(&mut connection)
                .await
                .expect("create referenced fixture row");
            sqlx::query("INSERT INTO references_record (id, record_id) VALUES (1, 10)")
                .execute(&mut connection)
                .await
                .expect("create child fixture row");
            connection.close().await.expect("close fixture");

            let committed = execute_transaction_at_path(
                &database_path,
                &[
                    statement(
                        "DELETE FROM records WHERE id = ?",
                        vec![serde_json::json!(10)],
                    ),
                    statement(
                        "INSERT INTO records (id, value) VALUES (?, ?)",
                        vec![serde_json::json!(10), serde_json::json!("reinserted")],
                    ),
                    statement(
                        "INSERT INTO records (id, value) VALUES (?, ?)",
                        vec![serde_json::json!(1), serde_json::json!("first")],
                    ),
                    statement(
                        "INSERT INTO records (id, value) VALUES (?, ?)",
                        vec![serde_json::json!(2), serde_json::json!("second")],
                    ),
                ],
            )
            .await
            .expect("commit native batch");
            assert_eq!(committed.statements, 4);
            assert_eq!(committed.rows_affected, 4);

            let visible_after_commit = select_at_path(
                &database_path,
                &statement(
                    "SELECT value FROM records WHERE id = ?",
                    vec![serde_json::json!(1)],
                ),
            )
            .await
            .expect("read committed native batch through authoritative read path");
            assert_eq!(
                visible_after_commit[0].get("value"),
                Some(&serde_json::json!("first")),
                "a committed mutation must be visible to the next repository read without restart"
            );

            let rolled_back = execute_transaction_at_path(
                &database_path,
                &[
                    statement(
                        "INSERT INTO records (id, value) VALUES (?, ?)",
                        vec![serde_json::json!(3), serde_json::json!("third")],
                    ),
                    statement(
                        "INSERT INTO missing_table (id) VALUES (?)",
                        vec![serde_json::json!(4)],
                    ),
                ],
            )
            .await;
            assert!(rolled_back.is_err());

            let options = SqliteConnectOptions::new()
                .filename(&database_path)
                .create_if_missing(false);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .expect("reopen transaction fixture");
            let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM records")
                .fetch_one(&mut connection)
                .await
                .expect("count committed fixture rows");
            assert_eq!(
                count.0, 3,
                "the failed batch must roll back its first statement"
            );
            connection.close().await.expect("close transaction fixture");
        });

        let _ = fs::remove_file(database_path);
    }
}

#[tauri::command]
fn store_secret(key: String, value: String) -> Result<(), String> {
    keychain_entry(&key)?
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_secret(key: String) -> Result<Option<String>, String> {
    match keychain_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    match keychain_entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn validate_external_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;

    if parsed.scheme() == "https" {
        return Ok(());
    }

    if parsed.scheme() == "http" {
        let host = parsed.host_str().unwrap_or_default();
        if matches!(host, "127.0.0.1" | "localhost") {
            return Ok(());
        }
    }

    Err("Only trusted web URLs can be opened externally.".to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("Unable to open browser: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("Unable to open browser: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("Unable to open browser: {error}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Opening external browser is not supported on this platform.".to_string())
    }
}

#[cfg(not(debug_assertions))]
fn wait_for_local_server(child: &mut Child, port: u16) -> Result<(), String> {
    for _ in 0..240 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Unable to inspect bundled server process: {error}"))?
        {
            return Err(format!(
                "Bundled Bezgrow server exited before it was ready with status {status}"
            ));
        }

        thread::sleep(Duration::from_millis(100));
    }

    Err("Bundled Bezgrow server did not become ready in time".to_string())
}

#[cfg(not(debug_assertions))]
fn reserve_local_port() -> Result<u16, Box<dyn std::error::Error>> {
    // WebKit storage is origin-scoped, so changing this port selects a different
    // localStorage/legacy IndexedDB workspace. Never silently fall back to a
    // random port and present an empty business.
    let listener = TcpListener::bind(("127.0.0.1", DESKTOP_SERVER_PORT)).map_err(|error| {
        format!(
            "Bezgrow desktop port {DESKTOP_SERVER_PORT} is unavailable. Close the other Bezgrow instance and reopen the app: {error}"
        )
    })?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

#[cfg(not(debug_assertions))]
fn bundled_node_path(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let executable_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node_path = app
        .path()
        .resource_dir()?
        .join("node")
        .join(executable_name);

    if !node_path.exists() {
        return Err(format!(
            "Bundled Node runtime was not found at {}",
            node_path.display()
        )
        .into());
    }

    Ok(node_path)
}

#[cfg(debug_assertions)]
fn start_next_server(app: &mut tauri::App) -> Result<u16, Box<dyn std::error::Error>> {
    append_startup_log(app, "Using Next.js dev server at http://localhost:3000");
    Ok(3000)
}

#[cfg(not(debug_assertions))]
fn start_next_server(app: &mut tauri::App) -> Result<u16, Box<dyn std::error::Error>> {
    let port = reserve_local_port()?;
    let resource_dir = app.path().resource_dir()?;
    let server_dir = app.path().resource_dir()?.join("next-server");
    let server_entry = server_dir.join("server.js");
    let node_path = bundled_node_path(app)?;
    let log_path = startup_log_path(app);

    append_startup_log(
        app,
        format!(
            "Starting bundled Next server. resources={}, node={}, server={}, port={port}",
            resource_dir.display(),
            node_path.display(),
            server_entry.display()
        ),
    );

    if !server_entry.exists() {
        return Err(format!(
            "Bundled Next server was not found at {}",
            server_entry.display()
        )
        .into());
    }

    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;

    let mut child = Command::new(&node_path)
        .arg(&server_entry)
        .current_dir(&server_dir)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("BEZGROW_DESKTOP_BUILD", "1")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file))
        .spawn()
        .map_err(|error| {
            format!(
                "Unable to start bundled Bezgrow server with {}: {error}",
                node_path.display()
            )
        })?;

    if let Err(error) = wait_for_local_server(&mut child, port) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }

    let state = app.state::<NextServerState>();
    *state.0.lock().expect("next server state poisoned") = Some(child);
    append_startup_log(app, format!("Bundled Next server is ready on port {port}"));

    Ok(port)
}

fn create_main_window(app: &mut tauri::App, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/login"))?;
    let runtime_mode = if cfg!(debug_assertions) {
        "tauri-dev"
    } else {
        "tauri-packaged"
    };
    let runtime_script = format!(
        "window.__BEZGROW_DESKTOP__ = true; window.__BEZGROW_RUNTIME__ = \"{runtime_mode}\"; window.isTauri = true;"
    );

    tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Bezgrow ERP")
        .inner_size(1360.0, 860.0)
        .min_inner_size(1100.0, 720.0)
        .resizable(true)
        .fullscreen(false)
        .initialization_script(runtime_script)
        .build()?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            app.manage(NextServerState(Mutex::new(None)));

            match start_next_server(app).and_then(|port| create_main_window(app, port)) {
                Ok(()) => {
                    append_startup_log(app, "Bezgrow desktop window opened successfully");
                }
                Err(error) => {
                    let startup_error = error.to_string();
                    append_startup_log(
                        app,
                        format!("Startup failed before main window opened: {startup_error}"),
                    );

                    if let Err(window_error) = create_startup_error_window(app, &startup_error) {
                        append_startup_log(
                            app,
                            format!("Unable to show startup error window: {window_error}"),
                        );
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    let app = window.app_handle();
                    append_startup_log_handle(
                        &app,
                        format!(
                            "Native close requested for window={}; exiting application",
                            window.label()
                        ),
                    );
                    stop_next_server(&app);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_database_diagnostics,
            desktop_database_backup,
            desktop_select,
            desktop_execute_transaction,
            desktop_startup_log,
            store_secret,
            read_secret,
            delete_secret,
            open_external_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bezgrow ERP")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                stop_next_server(app);
            }
        });
}
