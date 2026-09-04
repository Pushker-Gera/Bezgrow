#![cfg(any(target_os = "macos", target_os = "windows"))]

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

// Never touch a production credential, licence, Device ID, or admin key.
const TEST_SERVICE: &str = "com.bezgrow.erp.credential-persistence-test";
const TEST_VALUE: &str = "non-secret-native-persistence-fixture";
const TEST_ACCOUNT_ENV: &str = "BEZGROW_CREDENTIAL_TEST_ACCOUNT";

#[test]
fn native_backend_must_not_be_mock() {
    let entry = keyring::Entry::new(TEST_SERVICE, "backend-type-check").unwrap();
    assert!(
        !entry.get_credential().is::<keyring::mock::MockCredential>(),
        "Production native targets must explicitly enable their keyring backend"
    );
}

#[test]
fn credential_store_child() {
    let Ok(account) = std::env::var(TEST_ACCOUNT_ENV) else {
        return;
    };
    let operation = std::env::var("BEZGROW_CREDENTIAL_TEST_OPERATION").unwrap();
    let entry = keyring::Entry::new(TEST_SERVICE, &account).unwrap();
    match operation.as_str() {
        "write" => entry.set_password(TEST_VALUE).unwrap(),
        "read" => {
            // Use a boolean assertion so even a failing test never logs a value.
            assert!(entry.get_password().is_ok_and(|value| value == TEST_VALUE));
        }
        _ => panic!("Unsupported credential fixture operation"),
    }
}

#[test]
#[ignore = "Requires an unlocked native OS credential store; explicitly run by desktop CI"]
fn native_credential_survives_process_restart() {
    let account = format!(
        "fixture-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let entry = keyring::Entry::new(TEST_SERVICE, &account).unwrap();
    assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));

    let child = |operation: &str| {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "credential_store_child"])
            .env(TEST_ACCOUNT_ENV, &account)
            .env("BEZGROW_CREDENTIAL_TEST_OPERATION", operation)
            .status()
            .unwrap()
            .success()
    };
    let write_ok = child("write");
    let read_ok = write_ok && child("read");
    // Only this test's unique disposable item is removed, even on failure.
    let cleanup_ok = matches!(
        entry.delete_credential(),
        Ok(()) | Err(keyring::Error::NoEntry)
    );
    assert!(write_ok, "Native fixture writer failed");
    assert!(
        read_ok,
        "A new process could not read the native credential"
    );
    assert!(cleanup_ok, "Disposable native fixture cleanup failed");
}
