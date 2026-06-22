use std::{process::Child, sync::Mutex};

#[cfg(not(debug_assertions))]
use std::{
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use tauri::{Manager, WebviewUrl};

const KEYCHAIN_SERVICE: &str = "com.bezgrow.erp";

struct NextServerState(Mutex<Option<Child>>);

fn keychain_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|error| error.to_string())
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

#[cfg(not(debug_assertions))]
fn wait_for_local_server(port: u16) -> bool {
    for _ in 0..120 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }

        thread::sleep(Duration::from_millis(250));
    }

    false
}

#[cfg(not(debug_assertions))]
fn reserve_local_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
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
fn start_next_server(_app: &mut tauri::App) -> Result<u16, Box<dyn std::error::Error>> {
    Ok(3000)
}

#[cfg(not(debug_assertions))]
fn start_next_server(app: &mut tauri::App) -> Result<u16, Box<dyn std::error::Error>> {
    let port = reserve_local_port()?;
    let server_dir = app.path().resource_dir()?.join("next-server");
    let server_entry = server_dir.join("server.js");
    let node_path = bundled_node_path(app)?;

    if !server_entry.exists() {
        return Err(format!(
            "Bundled Next server was not found at {}",
            server_entry.display()
        )
        .into());
    }

    let child = Command::new(&node_path)
        .arg(&server_entry)
        .current_dir(&server_dir)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            format!(
                "Unable to start bundled Bezgrow server with {}: {error}",
                node_path.display()
            )
        })?;

    let state = app.state::<NextServerState>();
    *state.0.lock().expect("next server state poisoned") = Some(child);

    if !wait_for_local_server(port) {
        return Err("Bundled Bezgrow server did not become ready in time".into());
    }

    Ok(port)
}

fn create_main_window(app: &mut tauri::App, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}"))?;

    tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Bezgrow ERP")
        .inner_size(1360.0, 860.0)
        .min_inner_size(1100.0, 720.0)
        .resizable(true)
        .fullscreen(false)
        .build()?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            app.manage(NextServerState(Mutex::new(None)));
            let port = start_next_server(app)?;
            create_main_window(app, port)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<NextServerState>() {
                    if let Some(mut child) =
                        state.0.lock().expect("next server state poisoned").take()
                    {
                        let _ = child.kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            store_secret,
            read_secret,
            delete_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running Bezgrow ERP");
}
