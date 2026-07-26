# Bezgrow Admin Control-Plane Compatibility Report

Generated before implementation changes on 2026-07-26 (Asia/Kolkata).

## Production target and inspection method

- Configured Supabase project reference: `slqtzcshrmqrattnmvvp`
- Production comparison used the repository's server-only service-role configuration through read-only Supabase Auth and PostgREST calls.
- No secrets or private signing material were printed, stored, or sent to a client.
- No production data was changed during this comparison.
- The repository has no `supabase/config.toml`, installed Supabase CLI, local project link, database password, or management token visible to the application. DDL application therefore requires a separately authenticated Supabase CLI/management session or the Supabase SQL Editor.

## Root compatibility finding

The exact unapplied repository migration is:

`supabase/migrations/20260726120000_admin_control_plane.sql`

The production API schema proves that the migration was not applied:

- Twelve of the thirteen expected control-plane tables return `PGRST205` (relation absent from the production API schema).
- `platform_settings` exists, but only its older `id`, `platform_name`, `support_email`, and `updated_at` columns are available.
- `admin_control_plane_dashboard(uuid)` and `admin_control_plane_analytics(uuid, integer)` return `PGRST202` (function absent).
- No control-plane schema status/version RPC exists.

The deployed warning is therefore caused by a real schema mismatch. It must not be hidden.

## Code contract versus production

| Object | Required by current application | Production state before repair |
| --- | --- | --- |
| `platform_customers` | Customer list/edit, license ownership, support aggregation | Missing (`PGRST205`) |
| `platform_businesses` | Cloud-known businesses, license/device association, backup metadata | Missing (`PGRST205`) |
| `licenses` | Generate, list, download, renew, extend, suspend, revoke, replace, transfer | Missing (`PGRST205`) |
| `license_control_plane` | Effective license status, list/filter/export | Missing with base table |
| `license_events` | License history and renewal analytics | Missing (`PGRST205`) |
| `registered_devices` | Device inventory, activation/check-in, replacement, revocation, diagnostics | Missing (`PGRST205`) |
| `device_checkins` | Report history and update outcomes | Missing (`PGRST205`) |
| `desktop_releases` | Release list/create/publish/rollout/update checks | Missing (`PGRST205`) |
| `release_artifacts` | URL, size, SHA-256, signature/notarization/code-signing validation | Missing (`PGRST205`) |
| `backup_status` | Optional cloud backup/sync metadata | Missing (`PGRST205`) |
| `support_cases` | Support create/update, diagnostic association | Missing (`PGRST205`) |
| `diagnostic_uploads` | Sanitized device diagnostic uploads | Missing (`PGRST205`) |
| `admin_audit_logs` | Login, mutation and security audit history/export | Missing (`PGRST205`) |
| `platform_settings` | License/update/backup/diagnostic/download defaults | Exists with 4 legacy columns; 14 required columns missing (`42703`) |
| `is_platform_admin()` | Authoritative profile-role RLS check | Exists |
| `admin_control_plane_dashboard(uuid)` | `/admin` statistics | Missing (`PGRST202`) |
| `admin_control_plane_analytics(uuid, integer)` | `/admin/analytics` series | Missing (`PGRST202`) |
| Schema version/status object | Accurate server-side readiness verification | Missing (`PGRST202`) |

## Required columns

The code and final migration must agree on the following application-facing columns:

- `platform_customers`: `id`, `name`, `email`, `phone`, `company`, `country`, `account_status`, `support_status`, `notes`, `last_platform_activity_at`, `created_at`, `updated_at`
- `platform_businesses`: `id`, `platform_customer_id`, `legacy_organization_id`, `workspace_id`, `business_name`, `plan_name`, `status`, `platform`, `app_version`, `update_channel`, `cloud_mode`, `cloud_backup_enabled`, `last_sync_at`, `last_backup_at`, `telemetry_reported_at`, `telemetry_summary`, `created_at`, `updated_at`
- `licenses`: `id`, `platform_customer_id`, `platform_business_id`, `customer_name`, `customer_email`, `business_name`, `device_id`, `platform`, `app_version`, `plan_name`, `issue_date`, `expiry_date`, `grace_days`, `allowed_features`, `maximum_users`, `maximum_businesses`, `maximum_branches`, `internal_notes`, `status`, `signed_license_key`, `signature_algorithm`, `issuer_key_id`, `issued_by_admin_id`, `issued_by_admin_email`, `replaced_by_license_id`, `idempotency_key`, `created_at`, `updated_at`
- `license_events`: `id`, `license_id`, `action`, `admin_user_id`, `admin_email`, `previous_values`, `new_values`, `notes`, `request_id`, `created_at`
- `registered_devices`: `id`, `device_id`, `platform_customer_id`, `platform_business_id`, `license_id`, `platform`, `operating_system`, `architecture`, `app_version`, `activation_date`, `last_reported_at`, `last_update_check_at`, `release_channel`, `device_status`, `diagnostics_available`, `diagnostic_requested_at`, `online_session_version`, `replaced_by_device_id`, `created_at`, `updated_at`
- `device_checkins`: `id`, `registered_device_id`, `app_version`, `release_channel`, `update_check_result`, `license_status`, `request_id`, `reported_at`
- `desktop_releases`: `id`, `version`, `build_number`, `platform`, `architecture`, `release_channel`, `release_status`, `minimum_supported_version`, `release_notes`, `rollout_percentage`, `mandatory`, `active`, `published_at`, `created_by_admin_id`, `created_at`, `updated_at`
- `release_artifacts`: `id`, `release_id`, `file_url`, `file_size`, `sha256`, `signature_status`, `notarization_status`, `code_signing_status`, `validation_status`, `validated_at`, `validation_error`, `created_at`, `updated_at`
- `backup_status`: `id`, `platform_business_id`, `cloud_backup_enabled`, `last_successful_backup_at`, `last_failed_backup_at`, `last_failure_code`, `backup_size`, `encryption_status`, `retention_policy`, `restore_request_status`, `sync_conflict_count`, `updated_at`
- `support_cases`: `id`, `case_number`, `subject`, `description`, `status`, `priority`, `platform_customer_id`, `registered_device_id`, `license_id`, `private_admin_notes`, `diagnostic_requested_at`, `assigned_admin_id`, `resolved_at`, `created_at`, `updated_at`
- `diagnostic_uploads`: `id`, `support_case_id`, `registered_device_id`, `app_version`, `operating_system`, `platform`, `device_id`, `database_integrity_result`, `migration_version`, `license_status`, `update_status`, `sanitized_error_codes`, `startup_timing_ms`, `last_backup_result`, `storage_path`, `requested_at`, `uploaded_at`, `expires_at`
- `admin_audit_logs`: `id`, `admin_user_id`, `admin_email`, `action`, `target_type`, `target_id`, `ip_address`, `user_agent`, `previous_values`, `new_values`, `request_id`, `result`, `created_at`
- `platform_settings`: the 4 existing columns plus `default_license_duration_days`, `default_grace_days`, `default_allowed_features`, `license_plans`, `update_channels`, `minimum_supported_version`, `backup_policies`, `diagnostic_upload_enabled`, `diagnostic_retention_days`, `maintenance_message`, `customer_download_urls`, `mac_release_status`, `windows_release_status`, `updated_by_admin_id`

## Authorization and secret boundary findings

- `pushkergera@gmail.com` exists in Supabase Auth.
- Its production `profiles` row exists with `role = 'admin'` and `is_suspended = false`.
- Server API authorization reads the authenticated user and then the authoritative production profile. `ADMIN_EMAIL` is not used as an authorization bypass.
- Every current `/api/admin/*` route calls the shared server-side `requireAdmin()` helper before data access.
- `SUPABASE_SERVICE_ROLE_KEY` and `BEZGROW_LICENSE_PRIVATE_KEY` are server-only environment names and are not `NEXT_PUBLIC_*`.
- The service-role client and private signing implementation import `server-only`.
- The license private key is read only by the server key store. It is not part of a Supabase row, API response, audit payload, or client/Tauri source.
- The public Ed25519 verification key is intentionally available as `NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY`.

## RLS and direct-access baseline

- The twelve absent tables have no production RLS policies because the relations do not exist.
- Anonymous reads against those absent names fail with `PGRST205`.
- Anonymous reads against the existing `platform_settings` relation return zero rows while the service role sees one row, demonstrating that its current data is not anonymously readable.
- Full live policy catalog inspection is not available through PostgREST alone. The final migration must create deterministic named policies and a schema-status RPC must verify RLS, required policies, indexes, constraints, triggers, functions and schema version from PostgreSQL catalogs.

## Existing migration defects to correct before production use

The generated migration is a useful initial contract but is not yet a safe final production migration:

1. It is not wrapped in a transaction.
2. Most existing-table compatibility paths do not add every required column.
3. It has no explicit schema version table/record or catalog-based readiness function.
4. Its UI warning helper recognizes missing tables only, not missing columns, functions, version, policies, indexes, constraints or triggers.
5. It grants authenticated admins direct `SELECT` only and revokes all authenticated mutations, rather than defining intended per-operation platform-admin policies.
6. It does not define owner-scoped customer access for diagnostic/support records where product endpoints require it.
7. It does not verify the required RLS/policy/trigger/index contract after creation.
8. Its production application mechanism is not currently available through a linked local Supabase CLI.

## Page contract assessment before repair

- Dashboard and analytics correctly use platform-only aggregates and do not infer revenue from ERP invoices, but both are blocked by missing RPCs.
- Licenses implement generation, copying, download, filtering, renewal, extension, suspension, revocation, replacement, history and CSV export, but all persistence is blocked by missing tables/view.
- Devices implement search, filters, pagination, issuance navigation, replacement/revocation and diagnostic requests, but persistence is blocked.
- Customers are separate from ERP retail customers and businesses expose cloud-known metadata only.
- Releases validate public HTTPS artifacts, size/SHA-256, signature, code signing and macOS notarization before publication. No Windows release is synthesized.
- Support, audit, backup, analytics and settings pages have bounded loading/error/empty states, but their backing objects are absent or incomplete.
- CSV export exists for licenses and audit logs. The remaining list pages do not currently expose CSV export despite the requested cross-page contract.

## Pre-change conclusion

The production failure is a genuine unapplied/incomplete admin control-plane schema. The safe repair must replace the current generated migration with one final idempotent migration/SQL-editor file, add exact schema verification, retain server-side role checks, preserve RLS, and only then apply and verify the production schema.
