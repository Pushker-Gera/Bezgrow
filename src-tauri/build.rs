fn main() {
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "desktop_database_diagnostics",
        "desktop_database_backup",
        "desktop_startup_log",
        "store_secret",
        "read_secret",
        "delete_secret",
        "open_external_url",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to run Tauri build script")
}
