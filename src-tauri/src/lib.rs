use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
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

use serde::Serialize;
use sha2::{Digest, Sha256};
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

    let Some(mut child) = state
        .0
        .lock()
        .expect("next server state poisoned")
        .take()
    else {
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
    let listener = TcpListener::bind(("127.0.0.1", DESKTOP_SERVER_PORT))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))?;
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
    let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}"))?;
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
            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::Destroyed = event {
                stop_next_server(&window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_database_diagnostics,
            desktop_database_backup,
            store_secret,
            read_secret,
            delete_secret,
            open_external_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building Bezgrow ERP")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
                stop_next_server(app);
            }
        });
}
