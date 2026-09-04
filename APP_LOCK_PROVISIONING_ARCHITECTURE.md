# App Lock provisioning architecture

## Reproduced root cause

The release declared `keyring = "3"` without native features. Keyring 3.6.3 has no default platform backend: on both macOS and Windows this selects `MockCredential`. Its value lives only in the individual entry object. `store_secret` created an entry, wrote successfully, and dropped it; `read_secret` created a new empty entry and returned no credential. This explains both successful admin authorization and a desktop that remained unprovisioned even immediately after an apparent install. The same configuration affected the canonical licence secret.

The backend type regression test failed against that original configuration. The corrected dependency enables `apple-native` and `windows-native`; native code additionally refuses a mock backend and verifies writes through a fresh entry. A disposable-item macOS Keychain test has passed with writing and reading in separate processes. No production credential was read or printed by that test.

Two delivery/storage defects compounded the native failure: the old gate read secure storage once without a recovery refresh, and object-valued watermark metadata silently became a SQLite row with NULL scalar values. The gate now reconciles signed local payloads even when check-in returns an unchanged key, and the non-secret watermark is explicitly JSON-serialized.

## Authoritative state model

`lib/app-lock/state.ts` defines the only four access states:

- `NO_VALID_LICENCE`: local licence policy does not permit ERP access. An App Password can never bypass this state.
- `PROVISIONING_REQUIRED`: the licence is valid, but the canonical OS credential store has no usable device-bound App Lock credential.
- `LOCKED`: the licence is valid and the canonical OS credential store contains a usable credential, but the user has not unlocked this process session.
- `UNLOCKED`: the licence and local credential are valid and the current process session accepted the App Password.

The required transition is `PROVISIONING_REQUIRED` → verified signed credential installation → `LOCKED` → accepted password → `UNLOCKED`. A rejected password remains `LOCKED`. Backgrounding, sleep, or an explicit lock request transitions `UNLOCKED` back to `LOCKED`.

## Admin creation and control-plane persistence

`app/api/admin/licenses/route.ts` handles `reset_app_password`. It validates the password policy and the exact PostgreSQL `updated_at` concurrency token, creates a one-way PBKDF2-SHA256 verifier in `lib/app-lock/server.ts`, and binds it to the existing licence `device_id`.

`lib/app-lock/reset-authorization.ts` creates a random authorization ID with canonical UTC RFC3339 millisecond timestamps. `expires_at` is exactly 30 minutes after `issued_at`.

The signed licence payload contains `app_lock` with:

- version and PBKDF2 algorithm parameters;
- random salt and one-way verifier;
- existing Device ID;
- credential ID and issued timestamp;
- reset authorization ID, issued timestamp, and expiry timestamp.

No plaintext password is stored. `supabase/migrations/20260824010000_app_lock_password_reset.sql` atomically replaces `licenses.signed_license_key`, writes the mutation ledger, licence event, and admin audit event, and restricts execution to the service role.

## Desktop discovery and verification

`lib/offline/local/license.ts` sends the device's current signed licence to `/api/devices/checkin`. `lib/device/report-auth.ts` verifies its signature and Device ID, finds the authoritative control-plane licence, and returns `refreshedLicenseKey` when the signed key changed.

The desktop parses the returned key without changing omitted optional fields, checks licence/customer/business/device/platform binding, verifies the licence signature, and then calls `provisionAppLockFromLicense`.

The desktop also reconciles an already-stored, signature-verified local licence with secure storage. This covers interrupted installs, restored databases, and the production regression where SQLite already held the current signed reset licence so check-in correctly returned no replacement key.

`lib/app-lock/provisioning-policy.ts` enforces Device ID binding, licence/business binding, reset expiry, one-time reset consumption, local-password preservation across renewal, and rollback protection.

## Canonical local persistence

`lib/app-lock/client.ts` writes the credential only through Tauri `store_secret` under `bezgrow-app-lock-v1`. `src-tauri/src/lib.rs` implements that command with the existing `keyring` backend:

- macOS: Keychain;
- Windows: Credential Manager.

The stored JSON contains only the verifier material and binding metadata, never the plaintext password. Both native and client code read back the saved entry before reporting installation. Mutations in the client are serialized. A reset arriving during password derivation invalidates the pending old-password attempt. SQLite stores a serialized non-secret watermark with binding IDs, reset-consumption marker, issue timestamp, and last successful install time. The watermark is not a second credential and cannot verify a password. Older, reordered reset responses cannot replace a newer installed credential.

The signed licence remains in SQLite `license_state` and the existing licence secret path. The installation Device ID remains in the canonical installation file and existing secure/cache migration paths; refresh, reset, renewal, and update never generate a replacement ID.

## Startup and reconnect behavior

`components/security/AppLockGate.tsx` reads canonical secure storage, reconciles a verified local licence, and checks the control plane in both provisioned and unprovisioned states:

- immediately;
- after network reconnect;
- after focus returns from Platform Admin;
- after visibility is restored;
- every 30 seconds while waiting;
- when the user chooses **Refresh App Lock**.

An unchanged credential does not relock an unlocked workspace. An actual credential-change event immediately locks it and clears pending password attempts. Local licence policy remains authoritative if remote refresh is unavailable, and ordinary offline unlock performs no network operation.

The same screen accepts a signed licence file through **Import / Refresh Licence**. Successful installation dispatches a credential-change event and transitions directly to `LOCKED` without an app reload.

`components/desktop/PlatformAdminLauncher.tsx` independently verifies the enrolled native admin-device key. It does not read ERP licence or App Lock state. Unauthorized devices never render the launcher; an authorized device rechecks after reconnect/focus and still requires Platform Admin account authentication.

## Compatibility and offline rules

`lib/license/codec.ts` preserves whether optional signed fields were omitted. A legacy signed payload without `app_lock` stays byte/semantic compatible and verifies without an injected `app_lock: null`.

Import or renewal of a signed legacy licence does not remove an existing local credential. If no credential exists, the licence is retained but App Lock remains `PROVISIONING_REQUIRED`; a password is never bypassed.

After one successful secure installation, password verification reads only the local OS credential store and works offline under the existing licence offline policy. Internet access is needed only to receive a new administrator-authorized reset or perform another control-plane operation.

Licence renewal re-signs the existing App Lock provisioning data but does not overwrite a locally changed credential. A fresh, valid reset authorization replaces the old verifier; the old password then fails and the new password succeeds across restart and update.

## Safe diagnostics

The Settings diagnostic export reports the Device ID, explicit App Lock state, local credential presence, signed-licence provisioning status, last credential install time, reset presence/expiry status, secure-storage backend, database path, licence status, and application version. It excludes passwords, salts, verifiers, signed licence keys, private keys, reset IDs, tokens, and business records.
