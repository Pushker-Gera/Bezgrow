# Production Admin Control-Plane Schema Drift Report — 2026-08-24

## Scope and target

- Production Supabase project host: `slqtzcshrmqrattnmvvp.supabase.co`
- Inspection path: repository-configured server-only service-role client plus the authenticated Supabase SQL editor
- Secrets, signed licence keys, and customer ERP records were not printed or copied.
- Customer ERP data remains local SQLite data; none of the migrations in this repair reference local ERP tables.

## Root cause

Production had applied `20260822030000_atomic_desktop_release_state.sql` while
skipping its prerequisite `20260822010000_atomic_license_mutations.sql`.
The later migration's rename guard accepted the then-current readiness function
and renamed the older `2026082102` checker to
`admin_control_plane_schema_status_2026082201`. As a result, production reported
`ready: true` at `2026082203` without checking the atomic licence mutation
relation, RPC, indexes, RLS, or service-role privileges.

Current source also required `20260824010000_app_lock_password_reset.sql`. Its
first production application failed safely inside its transaction with:

```text
ERROR: 42P01: relation "public.admin_license_mutations" does not exist
CONTEXT: compilation of PL/pgSQL function "admin_reset_app_password" near line 5
```

This proved the warning was caused by real production drift, not an environment,
authorization, PostgREST cache, or UI-only detection error.

## Explicit before/after drift

| Contract/object | Before repair | After repair |
| --- | --- | --- |
| Readiness result | `ready: true` (false positive) | `ready: true` |
| Advertised compatible contract | `2026082203` | `2026082401` |
| Actual migration history | `2026082203` | `2026082402` |
| `admin_license_mutations` | Missing | Present; forced RLS; service-role only |
| `admin_mutate_license(...)` | Missing with skipped migration | Present |
| `admin_reset_app_password(...)` | Missing | Present |
| Atomic licence indexes | Missing with skipped migration | Present |
| Atomic desktop release checks | Present but chained to a mislabeled prior checker | Independently rechecked |
| Missing arrays returned by readiness | Empty because prerequisite was not audited | Empty after direct catalog checks |

The application-facing contract intentionally remains `2026082401`: the
`2026082402` change strengthens readiness without changing the RPC response
shape or breaking the already-deployed 0.2.4 application. Updated source accepts
newer additive contracts while still rejecting an older contract.

## Migrations applied

1. `20260822010000_atomic_license_mutations.sql`
   - reviewed SHA-256: `c8ec953e57a79b08940ccece3f61667cebd58544963a06a620c83dfe45ddefd3`
2. `20260824010000_app_lock_password_reset.sql`
   - reviewed SHA-256: `9313c4cd0b71c6399e60b197d97f6ad5dfeecefdda1f4fcc98015054637a3a8a`
3. `20260824020000_admin_control_plane_chain_repair.sql`
   - final reviewed SHA-256: `73a7c1bb360ddd72010c61907d7100ef8010723a207ad09c801b7a135986a92a`

Each SQL editor payload was copied back and hash-compared with the reviewed
repository file before execution. All successful changes ran in transactions.

## Safety verification

- No migration drops, truncates, deletes, recreates, rekeys, or regenerates a
  licence, device, customer, or business record.
- Applying the migrations performs DDL and inserts idempotent schema-history
  rows only. Licence/device updates exist only inside the newly defined RPCs and
  were not invoked by migration application.
- The new mutation ledger uses `ON DELETE RESTRICT`, forced RLS, and service-role
  privileges only.
- The corrective readiness function independently verifies relations,
  functions, indexes, forced RLS, privileges, release columns, and constraints,
  preventing the same out-of-order false positive.

## Protected production counts

| Control-plane data | Before | After |
| --- | ---: | ---: |
| Licences | 13 | 13 |
| Registered devices | 7 | 7 |
| Platform customers | 4 | 4 |
| Platform businesses | 8 | 8 |
| Desktop releases | 15 | 15 |
| Release artifacts | 39 | 39 |
| Licence events | 294 | 294 |
| Admin audit logs | 444 | 444 |
| Platform settings | 1 | 1 |
| Atomic licence mutation ledger | Missing | 0 |

The authorized owner device remained active, authorized for Platform
Administration, bound to the expected owner admin identity, and not revoked.

## Post-repair live verification

`npm run test:live-control-plane` passed against production with:

- schema history `2026082402`;
- 13 licences and 7 devices;
- owner device authorization true;
- successful Dashboard sections for analytics, audit, backups, businesses,
  customers, devices, licences, releases, and support;
- no missing relations, functions, indexes, RLS, privileges, policies,
  constraints, columns, or triggers.

The production auth/RLS E2E also verified that anonymous users, ordinary users,
and platform-admin credentials without native authorized-device proof receive no
direct control-plane rows and cannot use the admin API.
