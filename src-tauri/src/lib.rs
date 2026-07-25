use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
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

use image::{GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
    Column, Connection, Row, SqliteConnection, TypeInfo, ValueRef,
};
use tauri::{Manager, WebviewUrl};

#[cfg(target_os = "macos")]
use objc2_app_kit::NSPrintInfo;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSavedFile {
    path: String,
    filename: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBusinessLogo {
    relative_path: String,
    absolute_path: String,
    mime_type: String,
    width: u32,
    height: u32,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLocalAsset {
    mime_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupAssetManifest {
    relative_path: String,
    checksum_sha256: String,
    bytes: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBackupManifest {
    app: String,
    format_version: u32,
    app_version: String,
    schema_version: i64,
    organization_id: String,
    created_at: String,
    database_checksum_sha256: String,
    database_bytes: u64,
    assets: Vec<BackupAssetManifest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRestoreResult {
    backup_path: String,
    pre_restore_backup_path: String,
    schema_version: i64,
    organization_id: String,
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

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn sanitize_filename(filename: &str, fallback: &str) -> String {
    let sanitized: String = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ' ') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(['.', '-', ' ']);
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn safe_extension(filename: &str, extension: &str) -> String {
    let suffix = format!(
        ".{}",
        extension.trim_start_matches('.').to_ascii_lowercase()
    );
    if filename.to_ascii_lowercase().ends_with(&suffix) {
        filename.to_string()
    } else {
        format!("{filename}{suffix}")
    }
}

fn save_bytes_with_dialog(
    filename: &str,
    bytes: &[u8],
    kind: &str,
) -> Result<Option<DesktopSavedFile>, String> {
    let (description, extension, fallback) = match kind {
        "pdf" => ("PDF document", "pdf", "Invoice.pdf"),
        "csv" => ("CSV spreadsheet", "csv", "bezgrow-export.csv"),
        "backup" => (
            "Bezgrow backup",
            "bezgrow-backup",
            "bezgrow-backup.bezgrow-backup",
        ),
        _ => return Err("Unsupported desktop file type.".to_string()),
    };
    let safe_name = safe_extension(&sanitize_filename(filename, fallback), extension);
    let destination = rfd::FileDialog::new()
        .set_file_name(&safe_name)
        .add_filter(description, &[extension])
        .save_file();
    let Some(path) = destination else {
        return Ok(None);
    };

    let parent = path
        .parent()
        .ok_or_else(|| "The selected destination folder is invalid.".to_string())?;
    if !parent.exists() {
        return Err("The selected destination folder no longer exists.".to_string());
    }

    let temporary = parent.join(format!(".{}.{}.tmp", safe_name, unix_timestamp()));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Unable to write the selected file: {error}"))?;
    if let Err(initial_error) = fs::rename(&temporary, &path) {
        let replacement_result = if path.exists() {
            fs::remove_file(&path).and_then(|()| fs::rename(&temporary, &path))
        } else {
            Err(initial_error)
        };
        if let Err(error) = replacement_result {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "Unable to finish saving the selected file: {error}"
            ));
        }
    }

    let metadata =
        fs::metadata(&path).map_err(|error| format!("Unable to verify the saved file: {error}"))?;
    Ok(Some(DesktopSavedFile {
        path: path.to_string_lossy().to_string(),
        filename: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&safe_name)
            .to_string(),
        bytes: metadata.len(),
    }))
}

fn image_signature(bytes: &[u8]) -> Option<(ImageFormat, &'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some((ImageFormat::Png, "image/png", "png"));
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some((ImageFormat::Jpeg, "image/jpeg", "jpg"));
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some((ImageFormat::WebP, "image/webp", "webp"));
    }
    None
}

fn organization_asset_stem(organization_id: &str) -> Result<String, String> {
    let trimmed = organization_id.trim();
    if trimmed.is_empty() {
        return Err("A business must be selected before choosing a logo.".to_string());
    }
    Ok(sha256_bytes(trimmed.as_bytes())[..24].to_string())
}

fn local_asset_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("The local asset path is invalid.".to_string());
    }
    if !relative_path.starts_with("business-assets/") {
        return Err("The local asset is outside Bezgrow's managed asset folder.".to_string());
    }
    app.path()
        .app_data_dir()
        .map(|root| root.join(path))
        .map_err(|error| format!("Unable to resolve Bezgrow's local asset folder: {error}"))
}

#[tauri::command]
fn desktop_save_file(
    filename: String,
    bytes: Vec<u8>,
    file_kind: String,
) -> Result<Option<DesktopSavedFile>, String> {
    if bytes.is_empty() {
        return Err("The file is empty and was not saved.".to_string());
    }
    if file_kind == "pdf" && (bytes.len() < 5 || !bytes.starts_with(b"%PDF-")) {
        return Err("The generated invoice is not a valid PDF.".to_string());
    }
    if file_kind == "csv" && !bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err("The CSV export must be UTF-8 with an Excel-compatible BOM.".to_string());
    }
    save_bytes_with_dialog(&filename, &bytes, &file_kind)
}

#[tauri::command]
fn desktop_pick_business_logo<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    organization_id: String,
) -> Result<Option<DesktopBusinessLogo>, String> {
    const MAX_INPUT_BYTES: u64 = 5 * 1024 * 1024;
    const MAX_DIMENSION: u32 = 1200;

    let source = rfd::FileDialog::new()
        .add_filter("Business logo", &["png", "jpg", "jpeg", "webp"])
        .pick_file();
    let Some(source_path) = source else {
        return Ok(None);
    };
    let metadata = fs::metadata(&source_path)
        .map_err(|error| format!("Unable to inspect the selected logo: {error}"))?;
    if metadata.len() == 0 {
        return Err("The selected logo file is empty.".to_string());
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Err("The business logo must be 5 MB or smaller.".to_string());
    }

    let source_bytes = fs::read(&source_path)
        .map_err(|error| format!("Unable to read the selected logo: {error}"))?;
    let Some((format, mime_type, extension)) = image_signature(&source_bytes) else {
        return Err("Choose a valid PNG, JPEG, or WebP image.".to_string());
    };
    let decoded = image::load_from_memory_with_format(&source_bytes, format)
        .map_err(|_| "The selected logo is damaged or is not a supported image.".to_string())?;
    let (source_width, source_height) = decoded.dimensions();
    if source_width < 16 || source_height < 16 {
        return Err("The business logo must be at least 16 x 16 pixels.".to_string());
    }
    if source_width > 16_384 || source_height > 16_384 {
        return Err("The business logo dimensions are too large.".to_string());
    }

    let processed = if source_width > MAX_DIMENSION || source_height > MAX_DIMENSION {
        decoded.resize(
            MAX_DIMENSION,
            MAX_DIMENSION,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        decoded
    };
    let (width, height) = processed.dimensions();
    let mut output = Cursor::new(Vec::new());
    processed
        .write_to(&mut output, format)
        .map_err(|error| format!("Unable to process the selected logo: {error}"))?;
    let output = output.into_inner();

    let stem = organization_asset_stem(&organization_id)?;
    let relative_path = format!("business-assets/logos/{stem}.{extension}");
    let destination = local_asset_path(&app, &relative_path)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Unable to resolve the business logo folder.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create the business logo folder: {error}"))?;
    let temporary = parent.join(format!(".{stem}.{}.tmp", unix_timestamp()));
    fs::write(&temporary, &output)
        .map_err(|error| format!("Unable to save the processed business logo: {error}"))?;
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Unable to finish saving the business logo: {error}"))?;

    for candidate_extension in ["png", "jpg", "webp"] {
        if candidate_extension == extension {
            continue;
        }
        let _ = fs::remove_file(parent.join(format!("{stem}.{candidate_extension}")));
    }

    Ok(Some(DesktopBusinessLogo {
        relative_path,
        absolute_path: destination.to_string_lossy().to_string(),
        mime_type: mime_type.to_string(),
        width,
        height,
        bytes: output.len() as u64,
    }))
}

#[tauri::command]
fn desktop_remove_business_logo<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    relative_path: String,
) -> Result<(), String> {
    let path = local_asset_path(&app, &relative_path)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("Unable to remove the business logo: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_read_local_asset<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    relative_path: String,
) -> Result<DesktopLocalAsset, String> {
    let path = local_asset_path(&app, &relative_path)?;
    if !path.is_file() {
        return Err("The local business asset could not be found.".to_string());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Unable to read the local business asset: {error}"))?;
    let Some((_, mime_type, _)) = image_signature(&bytes) else {
        return Err("The local business asset is not a valid supported image.".to_string());
    };
    Ok(DesktopLocalAsset {
        mime_type: mime_type.to_string(),
        bytes,
    })
}

#[tauri::command]
fn desktop_print_current_webview<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        webview
            .with_webview(|platform_webview| unsafe {
                let native_webview = &*platform_webview.inner().cast::<WKWebView>();
                let print_info = NSPrintInfo::sharedPrintInfo();
                let operation = native_webview.printOperationWithPrintInfo(&print_info);
                operation.setShowsPrintPanel(true);
                operation.setShowsProgressPanel(true);
                operation.runOperation();
            })
            .map_err(|error| format!("Unable to open the macOS print panel: {error}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        Err("The native print panel is not available on this desktop platform.".to_string())
    }
}

async fn create_consistent_database_snapshot(
    database_path: &Path,
    snapshot_path: &Path,
) -> Result<(), String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open SQLite for backup: {error}"))?;
    sqlx::query("PRAGMA wal_checkpoint(FULL)")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to checkpoint SQLite before backup: {error}"))?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to lock SQLite for a consistent backup: {error}"))?;
    let copy_result = fs::copy(database_path, snapshot_path)
        .map(|_| ())
        .map_err(|error| format!("Unable to copy SQLite into the backup package: {error}"));
    let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
    copy_result
}

fn collect_asset_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current)
        .map_err(|error| format!("Unable to read Bezgrow's local assets: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect a local asset: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_asset_files(root, &path, files)?;
        } else if path.is_file() && path.strip_prefix(root).is_ok() {
            files.push(path);
        }
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to create a restore asset folder: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Unable to read a restore asset folder: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Unable to inspect a restore asset: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if source_path.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Unable to restore a business asset: {error}"))?;
        }
    }
    Ok(())
}

fn quoted_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quoted_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

async fn sqlite_schema_version(database_path: &Path) -> Result<i64, String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the backup database: {error}"))?;
    sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Unable to read the backup schema version: {error}"))
}

async fn verify_backup_database(
    database_path: &Path,
    organization_id: &str,
) -> Result<i64, String> {
    let options = SqliteConnectOptions::new()
        .filename(database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the backup database: {error}"))?;
    let quick = sqlx::query_scalar::<_, String>("PRAGMA quick_check")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Unable to run the backup integrity check: {error}"))?;
    if !quick.eq_ignore_ascii_case("ok") {
        return Err(format!(
            "The backup database failed its integrity check: {quick}"
        ));
    }
    let foreign_keys = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut connection)
        .await
        .map_err(|error| format!("Unable to verify backup relationships: {error}"))?;
    if !foreign_keys.is_empty() {
        return Err("The backup contains invalid database relationships.".to_string());
    }
    let business_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM organizations WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(organization_id)
    .fetch_one(&mut connection)
    .await
    .map_err(|error| format!("Unable to verify the backup business identity: {error}"))?;
    if business_count != 1 {
        return Err("This backup does not belong to the active business.".to_string());
    }
    sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Unable to read the backup schema version: {error}"))
}

async fn restore_database_contents(
    current_database: &Path,
    backup_database: &Path,
) -> Result<(), String> {
    let options = SqliteConnectOptions::new()
        .filename(current_database)
        .create_if_missing(false)
        .foreign_keys(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(10));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Unable to open the active database for restore: {error}"))?;
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to prepare the restore transaction: {error}"))?;
    sqlx::query("ATTACH DATABASE ? AS restore_db")
        .bind(backup_database.to_string_lossy().to_string())
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to attach the verified backup: {error}"))?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to begin the restore transaction: {error}"))?;

    let restore_result: Result<(), String> = async {
        let current_tables = sqlx::query_scalar::<_, String>(
            "SELECT name FROM main.sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
        )
        .fetch_all(&mut connection)
        .await
        .map_err(|error| format!("Unable to inspect active database tables: {error}"))?;
        let backup_tables: HashSet<String> = sqlx::query_scalar::<_, String>(
            "SELECT name FROM restore_db.sqlite_master WHERE type = 'table'",
        )
        .fetch_all(&mut connection)
        .await
        .map_err(|error| format!("Unable to inspect backup database tables: {error}"))?
        .into_iter()
        .collect();

        for table in &current_tables {
            let quoted_table = quoted_identifier(table);
            sqlx::query(&format!("DELETE FROM main.{quoted_table}"))
                .execute(&mut connection)
                .await
                .map_err(|error| format!("Unable to clear {table} during restore: {error}"))?;
            if !backup_tables.contains(table) {
                continue;
            }

            let current_columns = sqlx::query_scalar::<_, String>(&format!(
                "SELECT name FROM pragma_table_info({}, 'main')",
                quoted_sql_string(table)
            ))
            .fetch_all(&mut connection)
            .await
            .map_err(|error| format!("Unable to inspect active {table} columns: {error}"))?;
            let backup_columns: HashSet<String> = sqlx::query_scalar::<_, String>(&format!(
                "SELECT name FROM pragma_table_info({}, 'restore_db')",
                quoted_sql_string(table)
            ))
            .fetch_all(&mut connection)
            .await
            .map_err(|error| format!("Unable to inspect backup {table} columns: {error}"))?
            .into_iter()
            .collect();
            let shared_columns: Vec<String> = current_columns
                .into_iter()
                .filter(|column| backup_columns.contains(column))
                .collect();
            if shared_columns.is_empty() {
                continue;
            }
            let columns = shared_columns
                .iter()
                .map(|column| quoted_identifier(column))
                .collect::<Vec<_>>()
                .join(", ");
            sqlx::query(&format!(
                "INSERT INTO main.{quoted_table} ({columns})
                 SELECT {columns} FROM restore_db.{quoted_table}"
            ))
            .execute(&mut connection)
            .await
            .map_err(|error| format!("Unable to restore {table}: {error}"))?;
        }

        let foreign_key_rows = sqlx::query("PRAGMA main.foreign_key_check")
            .fetch_all(&mut connection)
            .await
            .map_err(|error| format!("Unable to validate restored relationships: {error}"))?;
        if !foreign_key_rows.is_empty() {
            return Err("The restored database would contain invalid relationships.".to_string());
        }
        Ok(())
    }
    .await;

    match restore_result {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(&mut connection)
                .await
                .map_err(|error| format!("Unable to commit the restore transaction: {error}"))?;
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
            let _ = sqlx::query("DETACH DATABASE restore_db")
                .execute(&mut connection)
                .await;
            return Err(error);
        }
    }
    sqlx::query("DETACH DATABASE restore_db")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Unable to finish the restore operation: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn desktop_export_backup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    organization_id: String,
    filename: String,
) -> Result<Option<DesktopSavedFile>, String> {
    let safe_filename = safe_extension(
        &sanitize_filename(&filename, "bezgrow-backup.bezgrow-backup"),
        "bezgrow-backup",
    );
    let destination = rfd::FileDialog::new()
        .set_file_name(&safe_filename)
        .add_filter("Bezgrow backup", &["bezgrow-backup"])
        .save_file();
    let Some(destination) = destination else {
        return Ok(None);
    };

    let database_path = local_database_path(&app)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve Bezgrow's local data folder: {error}"))?;
    let staging = app_data
        .join("backups")
        .join(format!("export-staging-{}", unix_timestamp()));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Unable to create the backup staging folder: {error}"))?;
    let snapshot = staging.join("database.sqlite");
    create_consistent_database_snapshot(&database_path, &snapshot).await?;
    let schema_version = verify_backup_database(&snapshot, &organization_id).await?;
    let database_checksum_sha256 = sha256_file(&snapshot)?;
    let database_bytes = fs::metadata(&snapshot)
        .map_err(|error| format!("Unable to inspect the database snapshot: {error}"))?
        .len();

    let asset_root = app_data.join("business-assets");
    let mut asset_files = Vec::new();
    collect_asset_files(&app_data, &asset_root, &mut asset_files)?;
    let mut assets = Vec::new();
    for asset in &asset_files {
        let relative = asset
            .strip_prefix(&app_data)
            .map_err(|_| "Unable to package a local business asset.".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        assets.push(BackupAssetManifest {
            relative_path: relative,
            checksum_sha256: sha256_file(asset)?,
            bytes: fs::metadata(asset)
                .map_err(|error| format!("Unable to inspect a local business asset: {error}"))?
                .len(),
        });
    }
    let manifest = DesktopBackupManifest {
        app: "Bezgrow".to_string(),
        format_version: 1,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version,
        organization_id,
        created_at: unix_timestamp(),
        database_checksum_sha256,
        database_bytes,
        assets,
    };

    let temporary_package = staging.join("package.tmp");
    let package_file = fs::File::create(&temporary_package)
        .map_err(|error| format!("Unable to create the backup package: {error}"))?;
    let mut archive = zip::ZipWriter::new(package_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    archive
        .start_file("manifest.json", options)
        .map_err(|error| format!("Unable to write the backup manifest: {error}"))?;
    archive
        .write_all(
            serde_json::to_string_pretty(&manifest)
                .map_err(|error| format!("Unable to encode the backup manifest: {error}"))?
                .as_bytes(),
        )
        .map_err(|error| format!("Unable to write the backup manifest: {error}"))?;
    archive
        .start_file("database.sqlite", options)
        .map_err(|error| format!("Unable to add SQLite to the backup package: {error}"))?;
    let mut database_file = fs::File::open(&snapshot)
        .map_err(|error| format!("Unable to read the database snapshot: {error}"))?;
    std::io::copy(&mut database_file, &mut archive)
        .map_err(|error| format!("Unable to package the database snapshot: {error}"))?;
    for (asset, asset_manifest) in asset_files.iter().zip(manifest.assets.iter()) {
        archive
            .start_file(format!("assets/{}", asset_manifest.relative_path), options)
            .map_err(|error| format!("Unable to add a business asset to the backup: {error}"))?;
        let mut file = fs::File::open(asset)
            .map_err(|error| format!("Unable to read a business asset: {error}"))?;
        std::io::copy(&mut file, &mut archive)
            .map_err(|error| format!("Unable to package a business asset: {error}"))?;
    }
    archive
        .finish()
        .map_err(|error| format!("Unable to finish the backup package: {error}"))?;

    let parent = destination
        .parent()
        .ok_or_else(|| "The selected backup destination is invalid.".to_string())?;
    if !parent.exists() {
        return Err("The selected backup destination no longer exists.".to_string());
    }
    fs::rename(&temporary_package, &destination)
        .map_err(|error| format!("Unable to save the backup package: {error}"))?;
    let result = DesktopSavedFile {
        path: destination.to_string_lossy().to_string(),
        filename: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&safe_filename)
            .to_string(),
        bytes: fs::metadata(&destination)
            .map_err(|error| format!("Unable to verify the backup package: {error}"))?
            .len(),
    };
    let _ = fs::remove_dir_all(&staging);
    Ok(Some(result))
}

#[tauri::command]
async fn desktop_restore_backup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    organization_id: String,
) -> Result<Option<DesktopRestoreResult>, String> {
    let source = rfd::FileDialog::new()
        .add_filter("Bezgrow backup", &["bezgrow-backup"])
        .pick_file();
    let Some(source) = source else {
        return Ok(None);
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve Bezgrow's local data folder: {error}"))?;
    let staging = app_data
        .join("backups")
        .join(format!("restore-staging-{}", unix_timestamp()));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Unable to create the restore staging folder: {error}"))?;

    let package = fs::File::open(&source)
        .map_err(|error| format!("Unable to open the selected backup: {error}"))?;
    let mut archive = zip::ZipArchive::new(package)
        .map_err(|_| "The selected file is not a valid Bezgrow backup package.".to_string())?;
    let manifest: DesktopBackupManifest = {
        let mut entry = archive
            .by_name("manifest.json")
            .map_err(|_| "The backup manifest is missing.".to_string())?;
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("Unable to read the backup manifest: {error}"))?;
        serde_json::from_slice(&bytes).map_err(|_| "The backup manifest is damaged.".to_string())?
    };
    if manifest.app != "Bezgrow" || manifest.format_version != 1 {
        return Err("This is not a compatible Bezgrow backup package.".to_string());
    }
    if manifest.organization_id != organization_id {
        return Err("This backup belongs to a different business/workspace.".to_string());
    }

    let backup_database = staging.join("database.sqlite");
    {
        let mut entry = archive
            .by_name("database.sqlite")
            .map_err(|_| "The backup database is missing.".to_string())?;
        let mut output = fs::File::create(&backup_database)
            .map_err(|error| format!("Unable to prepare the backup database: {error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Unable to extract the backup database: {error}"))?;
    }
    if sha256_file(&backup_database)? != manifest.database_checksum_sha256 {
        return Err("The backup database checksum does not match its manifest.".to_string());
    }
    let current_database = local_database_path(&app)?;
    let current_schema = sqlite_schema_version(&current_database).await?;
    let backup_schema = verify_backup_database(&backup_database, &organization_id).await?;
    if backup_schema > current_schema || backup_schema != manifest.schema_version {
        return Err(format!(
            "The backup schema is not compatible with this Bezgrow version (backup {backup_schema}, installed {current_schema})."
        ));
    }

    let extracted_assets = staging.join("business-assets");
    for asset in &manifest.assets {
        let entry_name = format!("assets/{}", asset.relative_path);
        let mut entry = archive.by_name(&entry_name).map_err(|_| {
            format!(
                "A required backup asset is missing: {}",
                asset.relative_path
            )
        })?;
        let relative = Path::new(&asset.relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || !asset.relative_path.starts_with("business-assets/")
        {
            return Err("The backup contains an unsafe asset path.".to_string());
        }
        let trimmed_relative = relative
            .strip_prefix("business-assets")
            .map_err(|_| "The backup contains an invalid asset path.".to_string())?;
        let destination = extracted_assets.join(trimmed_relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create a restore asset folder: {error}"))?;
        }
        let mut output = fs::File::create(&destination)
            .map_err(|error| format!("Unable to extract a backup asset: {error}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Unable to extract a backup asset: {error}"))?;
        if sha256_file(&destination)? != asset.checksum_sha256 {
            return Err(format!(
                "A backup asset checksum does not match: {}",
                asset.relative_path
            ));
        }
    }

    let pre_restore = app_data
        .join("backups")
        .join(format!("pre-restore-{}.db", unix_timestamp()));
    create_consistent_database_snapshot(&current_database, &pre_restore).await?;
    let active_assets = app_data.join("business-assets");
    let pre_restore_assets = app_data
        .join("backups")
        .join(format!("pre-restore-assets-{}", unix_timestamp()));
    if active_assets.exists() {
        copy_directory(&active_assets, &pre_restore_assets)?;
    }
    if active_assets.exists() {
        fs::remove_dir_all(&active_assets)
            .map_err(|error| format!("Unable to prepare business assets for restore: {error}"))?;
    }
    if let Err(error) = copy_directory(&extracted_assets, &active_assets) {
        let _ = copy_directory(&pre_restore_assets, &active_assets);
        return Err(error);
    }

    if let Err(error) = restore_database_contents(&current_database, &backup_database).await {
        let _ = fs::remove_dir_all(&active_assets);
        let _ = copy_directory(&pre_restore_assets, &active_assets);
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = fs::remove_dir_all(&staging);
    Ok(Some(DesktopRestoreResult {
        backup_path: source.to_string_lossy().to_string(),
        pre_restore_backup_path: pre_restore.to_string_lossy().to_string(),
        schema_version: backup_schema,
        organization_id,
    }))
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

    if matches!(parsed.scheme(), "https" | "mailto") {
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

fn safe_invoice_filename(filename: &str) -> String {
    let sanitized: String = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches(['.', '-']);
    let base = if trimmed.is_empty() {
        "invoice.pdf"
    } else {
        trimmed
    };

    if base.to_ascii_lowercase().ends_with(".pdf") {
        base.to_string()
    } else {
        format!("{base}.pdf")
    }
}

#[tauri::command]
fn desktop_save_invoice_pdf(
    filename: String,
    bytes: Vec<u8>,
) -> Result<Option<DesktopSavedFile>, String> {
    if bytes.len() < 5 || !bytes.starts_with(b"%PDF-") {
        return Err("The generated invoice is not a valid PDF.".to_string());
    }
    save_bytes_with_dialog(&safe_invoice_filename(&filename), &bytes, "pdf")
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

#[tauri::command]
fn desktop_reveal_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.is_file() {
        return Err("The saved file could not be found.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|error| format!("Unable to show the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", target.to_string_lossy()))
            .spawn()
            .map_err(|error| format!("Unable to show the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let parent = target
            .parent()
            .ok_or_else(|| "The saved file folder could not be found.".to_string())?;
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|error| format!("Unable to show the saved file: {error}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Showing a saved file is not supported on this platform.".to_string())
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
        .on_window_event(|window, event| match event {
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
            desktop_save_file,
            desktop_save_invoice_pdf,
            desktop_pick_business_logo,
            desktop_remove_business_logo,
            desktop_read_local_asset,
            desktop_print_current_webview,
            desktop_reveal_file,
            desktop_export_backup,
            desktop_restore_backup,
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
