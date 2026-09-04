# App Lock and Accounting Phase 1 regression verification — 2026-09-04

Status: App Lock remediation and Accounting Phase 1 are implemented and locally verified at version 0.3.0. The final commit and `origin/main` result are recorded in the delivery handoff after push. Public release publication remains gated on matching Windows artifacts and Apple production signing/notarization. No production data was deleted.

## Requested acceptance report

1. **Exact root cause.** `keyring = "3"` compiled keyring 3.6.3 with no native backend features. Its default was `MockCredential`, which retains a value only in the individual entry object. `store_secret` created/wrote/dropped one entry; `read_secret` opened another empty entry. This prevented immediate credential read-back as well as restart persistence. The native backend regression test failed before the fix and passed after it. See the [keyring 3.6.3 backend documentation](https://docs.rs/keyring/3.6.3/keyring/#credential-store-features). Missing gate refresh/reconciliation and an incorrectly serialized SQLite watermark compounded the failure.

2. **Where reset was stored.** The server-only `admin_reset_app_password` RPC atomically updates `licenses.signed_license_key` and writes licence events, `admin_license_mutations`, and `admin_audit_logs`. A read-only live query confirmed `APP_PASSWORD_RESET_AUTHORIZED`, result `success`, at `2026-08-29T11:08:04.682+00:00` for the current licence `lic_d4da0510-477b-47a6-a7f2-44947118aa30`.

3. **Why provisioning persisted.** No credential survived a fresh secure-store handle; the old gate read it only once. SQLite already contained the signed reset, so identical-key check-ins did not reinstall it. A valid SQLite licence also bypassed the old secret-restore path. The saved reset has now expired and must not be replayed to bypass its 30-minute authorization window.

4. **Files changed.** Native backend configuration/lockfile and `src-tauri/src/lib.rs`; `src-tauri/tests/credential_persistence.rs`; App Lock client, state and provisioning policy; local licence reconciliation/diagnostics; AppLockGate, PlatformAdminLauncher and DesktopDiagnosticsPanel; App Lock client/contract, Windows, diagnostics, admin-entry and macOS lifecycle tests; package test script; desktop CI workflow; this record and the architecture document. Accounting Phase 1 adds the normalized journal schema, posting/reporting engine, atomic operational integrations, accounting workspace, migration/reconciliation/performance tests, and architecture record. The timestamp and codec implementations already present on the starting branch were retained and tested.

5. **State machine.** `NO_VALID_LICENCE` blocks ERP independently. A valid licence without a credential yields `PROVISIONING_REQUIRED`; verified/read-back installation yields `LOCKED`; correct password yields `UNLOCKED`; wrong password stays locked. An actual reset relocks an open workspace and invalidates an in-flight old-password attempt. Unchanged background refresh preserves the unlocked state.

6. **macOS storage.** Explicit `apple-native` backend, unchanged service `com.bezgrow.erp` and account `bezgrow-app-lock-v1`. Native code refuses mock storage and reopens the entry to verify writes; the client also verifies read-back. A real Keychain fixture passed separate writer/reader processes and removed only its unique disposable test item. Live production-password persistence still requires the fresh reset handoff.

7. **Windows storage.** Explicit `windows-native` backend, same canonical credential account, no second store. CI now requires real Credential Manager cross-process persistence. Windows contract checks pass on this Mac; the new Windows native/packaged test has **not run**.

8. **Timestamp/ISO result.** Existing canonical RFC3339 code passed 14 timestamp cases and 8 boundary cases with an exact 1,800,000-ms reset lifetime, including offsets and fractional seconds. No malformed timestamp was introduced. A fresh live reset submission remains pending.

9. **Legacy licence result.** The 24-case licence matrix passes; omission of `app_lock` is preserved without inserting `null` into signed payloads. Legacy import/renewal retains any existing local password; a device with no credential remains gated. All 3 licence rows in the actual Mac database still verify with Ed25519.

10. **Reset result.** Real client-code tests with substituted storage adapters pass `123456` → `ABC123`: old password rejected, new accepted; malformed, expired, wrong-device, consumed and older reordered reset cases protected. A fresh production admin-reset-to-password-screen test remains **pending user entry/submission**.

11. **Restart persistence result.** Real native Keychain cross-process persistence passes. Client reload fixtures retain the reset password and start locked. Actual packaged restart with a newly configured production password remains pending.

12. **Offline unlock result.** Real client password verification passes offline using retained fixture storage without network access. Live packaged offline password entry remains pending.

13. **Update persistence result.** Upgrade fixtures from 0.2.2, 0.2.3 and 0.2.4 preserve Device ID, signed licence, app-lock fixture, business data and admin-entry independence. Native migration/backup tests pass. Actual configured-password upgrade acceptance remains pending; fixture results are not an OS credential upgrade claim.

14. **Admin access result.** The enrolled-device launcher was visible on the rebuilt provisioning screen and opened the authenticated Platform Admin window. The live readiness audit confirms this device remains authorized. Unauthorized browser/device cases pass contract tests; no second physical device was tested.

15. **Device ID before/after.** Both are exactly `BZG-23D76F50F880422489AF152B`, read from the canonical installation file. No reset/refresh identity regeneration was added.

16. **Licence before/after.** Active; selected current-device licence expiry `2027-08-11`. All 3 stored licence signatures verify, invalid rows 0. SQLite quick-check remains `ok`. Before and after the rebuilt app launch, production counts are unchanged: products 8, customers 5, invoices 19, orders 1, licence rows 3.

17. **Mac test results.** Typecheck, lint and the complete `npm test` suite pass. Cargo check/fmt and 12 native unit tests plus native backend detection pass; the explicitly invoked cross-process Keychain test also passes. The rebuilt 0.3.0 app and DMG compile successfully with ad-hoc signing; notarization is skipped and not claimed. The final 20-cycle packaged lifecycle test passes single-instance enforcement, force-kill recovery, port fallback, SQLite integrity, and preservation of business/licence/device state. Native window-close automation was skipped because Accessibility permission was unavailable; normal quit was exercised instead. No production App Lock credential existed before the lifecycle run, so the run proves preservation of that absent state, while credential persistence is covered by the disposable native Keychain fixture.

18. **Windows test results.** Available source/platform contract checks pass and the native persistence test is wired into the Windows CI job. No physical Windows runner or generated Windows 0.3.0 installer was available locally, so no Windows restart, upgrade, reset, offline-unlock, or installer result is claimed.

19. **Version.** 0.3.0 is aligned in npm, Cargo, and Tauri metadata. Release notes document Accounting Phase 1, App Lock persistence remediation, verification scope, and remaining publication gates.

20. **Commit SHA.** The final clean commit SHA is recorded in the delivery handoff after the final source synchronization, rebuild, and push.

21. **origin/main.** The verified remote SHA is recorded in the delivery handoff after push; it must match the final clean commit exactly.

22. **External actions remaining.** Production App Lock acceptance still needs a newly authorized reset because the previous reset expired and no production credential is currently installed. Windows runtime acceptance needs a Windows host/CI run and a matching 0.3.0 installer. Public macOS publication needs Developer ID signing and notarization credentials. Public metadata remains pinned until matching release artifacts are available.

## Built local test artifacts

- App: `src-tauri/target/release/bundle/macos/Bezgrow.app`
- DMG: `src-tauri/target/release/bundle/dmg/Bezgrow_0.3.0_aarch64.dmg`
- Verified packaged lifecycle time: `2026-09-04T13:15:33.622Z`
- Production signing/notarization: neither claimed; this is an ad-hoc-signed manual-install test build.

The React review led to stale-attempt guards, async cleanup checks, focus/reconnect refresh in provisioned states, preservation of unlocked state on unchanged refreshes, parallelized independent accounting reads, primitive effect dependencies, and accessible controls. Browser verification covered the public site and the expected browser-only accounting redirect without console errors. Production credential entry remains an explicit acceptance handoff because the prior reset is expired.
