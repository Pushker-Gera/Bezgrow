# Bezgrow ERP Final Production Hardening Report

Date: 2026-07-12 IST / 2026-07-11 UTC
Branch: `final-production-hardening`

## Executive Status

Local production hardening was completed for the reproducible packaged desktop failure, the offline desktop database fallback risk, and broken desktop release/download metadata paths.

The app is not fully release-ready until the external blockers below are completed. The remaining blockers require credentials, signing/notarization access, production accounts, or a real E2E suite/runner.

## Reproduced Failure

The packaged desktop runtime was launched before the fix and reproduced a real bundled-server crash:

```text
Error: Cannot find module './chunks/4741.js'
Require stack:
- .../src-tauri/target/release/next-server/.next/server/webpack-runtime.js
- .../src-tauri/target/release/next-server/.next/server/app/_not-found/page.js
```

Root cause: `scripts/prepare-desktop-build.mjs` copied `.next/static` and `public`, but did not copy required `.next/server/chunks` assets into the standalone server before Tauri bundled it.

Additional reproduced download failures:

```text
GET /api/desktop-release returned stale published release metadata instead of the freshly generated local manifest.
HEAD https://github.com/Pushker-Gera/Bezgrow/releases/download/v0.1.1/Bezgrow-windows.exe -> 404
HEAD https://github.com/Pushker-Gera/Bezgrow/releases/download/v0.1.1/Bezgrow-mac.dmg -> 404
```

Root cause: download/update code invented default GitHub release URLs when no installer was present in the manifest or local build.

## Implemented Fixes

- Updated `scripts/prepare-desktop-build.mjs` to copy required `.next/server` assets, including server chunks and the interception route rewrite manifest.
- Added explicit runtime mode injection from Tauri (`tauri-dev` vs `tauri-packaged`) and client helpers in `lib/desktop/tauri.ts`.
- Changed desktop offline storage behavior to fail closed when Tauri SQLite is unavailable instead of silently using IndexedDB fallback.
- Added `LocalDatabaseRecovery` with retry and safe diagnostics export/copy.
- Added dashboard and offline activation guards that verify SQLite integrity before opening write paths.
- Sanitized `.env.e2e.example` so credential-like values cannot live in the tracked example file.
- Updated `/api/desktop-release` to prefer the local generated release manifest and fall back to the published manifest only when needed.
- Removed unverified hardcoded GitHub installer fallbacks from the download API, download page, and update helper.
- Changed missing Windows installer behavior to a clear JSON 404 instead of redirecting users to a GitHub 404.
- Added deterministic local QA scripts for desktop runtime config, offline safety, backup contract, and performance contract.
- Rebuilt the macOS desktop artifact and public release metadata.

## Verification Completed

Passed:

```text
npm run lint
npm run typecheck
npm test
npm run desktop:build
npm audit --audit-level=high
```

Packaged desktop smoke:

```text
src-tauri/target/release/bezgrow-erp
Bundled Next server is ready on port 43124
Bezgrow desktop window opened successfully
```

HTTP checks against the packaged server:

```text
GET /offline  -> 200 OK
GET /dashboard -> 307 /offline?next=%2Fdashboard
GET / -> 200 OK
GET /api/downloads/desktop?platform=windows -> 404 JSON, no broken GitHub redirect
GET /api/downloads/desktop?platform=mac -> local DMG redirect in web production server
```

SQLite local database check:

```text
Database: /Users/pushkergera/Library/Application Support/com.bezgrow.erp/bezgrow-offline.db
PRAGMA quick_check: ok
schema_migrations count: 6
schema_migrations max(version): 6
```

Security audit:

```text
found 0 vulnerabilities
```

## Blocked / Not Completed

These were not completed because the required external setup is absent:

- `npm run test:e2e` is blocked by missing E2E env variables, missing Playwright project dependency, and no Playwright E2E suite/config.
- `npm run preflight:final` is blocked by missing E2E secrets and missing license key environment variables:
  - `BEZGROW_E2E_ADMIN_EMAIL`
  - `BEZGROW_E2E_ADMIN_PASSWORD`
  - `BEZGROW_E2E_USER_EMAIL`
  - `BEZGROW_E2E_USER_PASSWORD`
  - `BEZGROW_E2E_BASE_URL`
  - `BEZGROW_LICENSE_PRIVATE_KEY`
  - `NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY`
- macOS notarization was skipped by Tauri because Apple signing/notarization credentials are not configured.
- Windows MSI/NSIS build and Windows signing were not run in this macOS-only local environment.
- Production Supabase dashboard backup verification was not performed because dashboard/credential access was not available.

## Verdict

The reproduced packaged desktop server crash is fixed and verified locally. Desktop SQLite now fails closed with a recovery screen instead of silently falling back to browser storage.

Release approval should remain blocked until E2E credentials/runner/tests, production license keys, Apple notarization, Windows packaging/signing, and production backup verification are completed.
