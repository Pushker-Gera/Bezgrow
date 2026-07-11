# Codex Final Run Guardrails

## Starting Point

- Active repository: `/Users/pushkergera/Desktop/saas-project`
- Active branch: `final-production-hardening`
- Recovery commit: `5711350`
- Filesystem backup: `/Users/pushkergera/Desktop/saas-project-backup-before-final-hardening`
- Expected final master-prompt starting point: this branch after repository-level preparation, with all prep docs and baseline evidence available.

## Protected Production Assets

Never delete, truncate, reset, or overwrite:

- Production Supabase data
- Local SQLite desktop data
- Organizations, businesses, users, admins, memberships, products, customers, suppliers, invoices, orders, payments, licenses, and device activations
- App support directories containing SQLite, license, settings, session, and keychain-backed data
- Existing production license-signing key pair

## Secrets Policy

- Never print, log, hardcode, commit, or copy passwords, tokens, service-role keys, private keys, Apple credentials, SMTP passwords, database passwords, session values, or private certificates.
- `.env`, `.env.local`, `.env.production`, `.env.e2e`, private keys, credential JSON, certificates, provisioning profiles, auth files, and session files must remain ignored.
- `.env.example` and `.env.e2e.example` may contain variable names and empty placeholders only.
- If a secret may have been committed historically, report rotation as a manual action. Do not attempt dashboard rotation without account access and authorization.

## Destructive Test Policy

Destructive E2E/load cleanup is forbidden unless all conditions are true:

- `NODE_ENV=test` or explicit E2E mode is set.
- `BEZGROW_E2E_ALLOW_DESTRUCTIVE_TESTS=true`.
- Target business/workspace name starts with `E2E-TEST-`.
- Target is not the primary production business.
- The admin account itself is never deleted.
- No unscoped delete, truncate, or drop-table operation is used.
- Cleanup logs exactly which test-owned records it will clean.
- Cleanup only removes records created by the current test-run id.

Shared guard: `lib/testing/e2e-safety.ts`

Required test-data prefix: `E2E-TEST-`

## Forbidden Operations

- Production wipe
- Global table truncation
- Deletion of the admin account
- Credential rotation without explicit approval and dashboard access
- License key rotation
- Direct push to `main`
- Public release publication
- Production deployment
- DNS changes
- Billing changes
- Apple account changes
- Sending real customer messages, WhatsApp messages, or emails from tests
- Destructive migration without a verified backup and approval

## External Release Blockers

- Supabase production backup must be created and restore-tested from the dashboard.
- Existing exposed or possibly exposed credentials must be rotated externally.
- Apple Developer signing identity and notarization credentials must be supplied and verified.
- Windows installer must be built and verified on Windows.
- Physical upgrade testing must confirm SQLite, license, settings, and business data survive an update.
