# Bezgrow Windows Release Readiness

This is the concise engineering root-cause record for the Windows x64 release.

## Root causes found

- The only historical Windows GitHub Actions run stopped before compilation because the public build path always required signing secrets. Unsigned internal test builds were impossible.
- The workflow was manual-only, mixed Windows x64 and incomplete ARM64 packaging, did not supply or validate the required public desktop variables, and did not run a native Rust compile check.
- The old installer test inspected files but did not repeatedly launch the installed application, wait for the bundled server, verify SQLite startup, or detect orphaned bundled Node processes.
- Release validation accepted any file beginning with `MZ`; it did not validate the PE signature, machine architecture, or a credible installer size.
- The website download API redirected to metadata URLs instead of returning a verified binary response with an attachment filename and binary content type.
- Windows-only publication could replace or attempt to republish unrelated macOS control-plane records.
- The generated Windows ICO lacked the required 20, 24, 40, 48, and 128 pixel entries, and its generator depended on macOS `sips`.
- Desktop preparation spawned `npm.cmd` indirectly and repeated the Next.js build during Tauri packaging. This was fragile with quoted Windows paths and increased build time.
- The bundled server readiness check proved only that a TCP port opened. It did not prove that the local Next.js route could respond.
- Child shutdown used a single-process kill fallback on Windows, which could leave the bundled Node process tree behind.
- Windows business data resolved through roaming `%APPDATA%` rather than local `%LOCALAPPDATA%`. A migration path was required to preserve existing data.
- A live SQLite file could be copied for backup while WAL writes were in progress. Backups now use a consistent database snapshot.
- There was no single-instance guard, allowing competing local server launches.
- Build-time secret exclusion was implicit. The desktop build now blanks server-only credentials and fails early unless all required public variables are present.
- Diagnostics existed only on the database recovery screen and used a browser download. Settings now exposes a sanitized report through the native Save dialog.
- Update installation is intentionally a verified manual-installer flow. Automatic replacement is not claimed.

## Release gate

A Windows release is publishable only when the `windows-latest` job:

1. passes lint, type checking, all contract/regression tests, Next.js build, `desktop:prepare`, `cargo fmt --check`, and `cargo check`;
2. builds Tauri for `x86_64-pc-windows-msvc`;
3. produces genuine NSIS and MSI installers;
4. validates PE architecture, minimum size, SHA-256, and Authenticode status;
5. installs and launches Bezgrow repeatedly, confirms `/login`, confirms SQLite creation, and confirms no orphaned bundled Node process;
6. uploads the exact versioned artifacts and publishes checksum-backed website metadata.

An unsigned run is an honest `internal` prerelease and must show a SmartScreen warning. A `stable` release requires valid Authenticode signatures.
