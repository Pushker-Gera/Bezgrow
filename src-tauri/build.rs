fn main() {
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "desktop_database_diagnostics",
        "desktop_database_backup",
        "desktop_execute",
        "desktop_select",
        "desktop_execute_transaction",
        "desktop_startup_log",
        "store_secret",
        "read_secret",
        "delete_secret",
        "desktop_save_file",
        "desktop_save_invoice_pdf",
        "desktop_pick_business_logo",
        "desktop_remove_business_logo",
        "desktop_read_local_asset",
        "desktop_print_current_webview",
        "desktop_reveal_file",
        "desktop_open_file",
        "desktop_export_backup",
        "desktop_restore_backup",
        "desktop_exit",
        "open_external_url",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to run Tauri build script")
}
