fn main() {
    println!("cargo:rustc-check-cfg=cfg(bezgrow_updater_enabled)");
    println!("cargo:rerun-if-env-changed=BEZGROW_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=BEZGROW_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=BEZGROW_BUILD_TIMESTAMP");
    let build_commit = std::env::var("BEZGROW_BUILD_COMMIT")
        .ok()
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .unwrap_or_else(|| "development".to_string());
    let build_timestamp = std::env::var("BEZGROW_BUILD_TIMESTAMP")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "development".to_string());
    println!("cargo:rustc-env=BEZGROW_BUILD_COMMIT={build_commit}");
    println!("cargo:rustc-env=BEZGROW_BUILD_TIMESTAMP={build_timestamp}");
    if std::env::var("BEZGROW_UPDATER_PUBLIC_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        println!("cargo:rustc-cfg=bezgrow_updater_enabled");
    }

    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "desktop_database_diagnostics",
        "desktop_database_backup",
        "desktop_prepare_update",
        "desktop_download_verified_release",
        "desktop_cancel_update_preparation",
        "desktop_restart_after_update",
        "desktop_execute",
        "desktop_select",
        "desktop_execute_transaction",
        "desktop_startup_log",
        "store_secret",
        "read_secret",
        "delete_secret",
        "desktop_save_file",
        "desktop_pick_business_logo",
        "desktop_remove_business_logo",
        "desktop_read_local_asset",
        "desktop_open_pdf_for_print",
        "desktop_reveal_file",
        "desktop_open_file",
        "desktop_export_backup",
        "desktop_restore_backup",
        "desktop_exit",
        "desktop_retry_startup",
        "open_external_url",
        "open_platform_admin",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to run Tauri build script")
}
