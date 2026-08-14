import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageVersion = packageJson.version;
const gitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const gitHead = (gitResult.stdout || "").trim();
const sourceStatusResult = spawnSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: root, encoding: "utf8" }
);
const sourceTreeDirty = sourceStatusResult.status !== 0 || sourceStatusResult.stdout.trim().length > 0;
const preparedBuildIdentityPath = join(root, "desktop-runtime", "next-server", "public", "desktop-build.json");
const preparedBuildIdentity = process.env.BEZGROW_DESKTOP_PREPARED === "1"
  ? JSON.parse(readFileSync(preparedBuildIdentityPath, "utf8"))
  : null;
const buildCommit = (
  process.env.BEZGROW_BUILD_COMMIT ||
  preparedBuildIdentity?.gitCommit ||
  gitHead
).trim();
const buildTimestamp = (
  process.env.BEZGROW_BUILD_TIMESTAMP ||
  preparedBuildIdentity?.builtAt ||
  new Date().toISOString()
).trim();
if (!/^[a-f0-9]{40}$/i.test(buildCommit)) {
  throw new Error("Desktop builds require a complete 40-character Git commit SHA.");
}
if (Number.isNaN(Date.parse(buildTimestamp))) {
  throw new Error("Desktop builds require a valid ISO-8601 build timestamp.");
}
const releaseNotes =
  (process.env.BEZGROW_RELEASE_NOTES || "").trim() ||
  `Bezgrow ${packageVersion} supervises the bundled production runtime, recovers before exposing a browser error, and preserves the authoritative offline SQLite database.`;
const tauriConfigPath = join(root, "src-tauri", "tauri.conf.json");
const generatedConfigDir = join(root, "src-tauri");
const generatedConfigPath = join(generatedConfigDir, "tauri.generated.conf.json");
const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const publicDownloadsDir = join(root, "public", "downloads");
const publicMacReleaseManifest = join(root, "public", "downloads", "Bezgrow-mac.dmg.release.json");
const publicWindowsExeReleaseManifest = join(publicDownloadsDir, "Bezgrow-windows.exe.release.json");
const publicWindowsMsiReleaseManifest = join(publicDownloadsDir, "Bezgrow-windows.msi.release.json");
const desktopReleaseManifest = join(publicDownloadsDir, "desktop-release.json");

const passthroughArgs = process.argv.slice(2);
const publicMacFlag = "--public-mac";
const publicWindowsFlag = "--public-windows";
const publicMacBuild = process.env.BEZGROW_MAC_PUBLIC_BUILD === "1" || passthroughArgs.includes(publicMacFlag);
const publicWindowsBuild = process.env.BEZGROW_WINDOWS_PUBLIC_BUILD === "1" || passthroughArgs.includes(publicWindowsFlag);
const tauriArgs = passthroughArgs.filter((arg) => arg !== publicMacFlag && arg !== publicWindowsFlag);
const targetArgumentIndex = tauriArgs.indexOf("--target");
const targetTriple = targetArgumentIndex >= 0 ? tauriArgs[targetArgumentIndex + 1] || "" : "";
const releaseRoot = targetTriple
  ? join(root, "src-tauri", "target", targetTriple, "release")
  : join(root, "src-tauri", "target", "release");
const publicMacFilename = `Bezgrow-${packageVersion}-${buildArchitecture("macos")}.dmg`;
const publicMacDmg = join(publicDownloadsDir, publicMacFilename);
const publicMacDownloadPath = `/downloads/${publicMacFilename}`;
const publicWindowsArchitecture = buildArchitecture("windows") === "x86_64" ? "x64" : "arm64";
const publicWindowsExeFilename = `Bezgrow-Setup-${packageVersion}-${publicWindowsArchitecture}.exe`;
const publicWindowsMsiFilename = `Bezgrow-${packageVersion}-${publicWindowsArchitecture}.msi`;
const publicWindowsExe = join(publicDownloadsDir, publicWindowsExeFilename);
const publicWindowsMsi = join(publicDownloadsDir, publicWindowsMsiFilename);
const publicWindowsExeDownloadPath = `/downloads/${publicWindowsExeFilename}`;
const publicWindowsMsiDownloadPath = `/downloads/${publicWindowsMsiFilename}`;

function preserveMacAppBundle(args) {
  if (process.platform !== "darwin") return args;
  const bundleIndex = args.indexOf("--bundles");
  if (bundleIndex === -1) return args;
  const requestedBundles = (args[bundleIndex + 1] || "")
    .split(",")
    .map((bundle) => bundle.trim())
    .filter(Boolean);
  if (!requestedBundles.includes("dmg") || requestedBundles.includes("app")) return args;
  const nextArgs = [...args];
  nextArgs[bundleIndex + 1] = ["app", ...requestedBundles].join(",");
  return nextArgs;
}

function envBoolean(name) {
  const value = (process.env[name] || "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function buildArchitecture(platform) {
  if (/aarch64|arm64/i.test(targetTriple)) return "arm64";
  if (/x86_64|x64|amd64/i.test(targetTriple)) return platform === "windows" ? "x86_64" : "x64";
  if (process.arch === "arm64") return "arm64";
  return platform === "windows" ? "x86_64" : "x64";
}

if (preparedBuildIdentity) {
  const expectedPlatform = process.platform === "win32" || targetTriple.includes("windows")
    ? "windows"
    : process.platform === "darwin" || targetTriple.includes("apple-darwin")
      ? "macos"
      : "linux";
  const expectedArchitecture = buildArchitecture(expectedPlatform) === "x86_64"
    ? "x64"
    : buildArchitecture(expectedPlatform);
  if (
    preparedBuildIdentity.applicationVersion !== packageVersion ||
    preparedBuildIdentity.gitCommit !== gitHead ||
    preparedBuildIdentity.gitCommit !== buildCommit ||
    preparedBuildIdentity.builtAt !== buildTimestamp ||
    preparedBuildIdentity.platform !== expectedPlatform ||
    preparedBuildIdentity.architecture !== expectedArchitecture ||
    preparedBuildIdentity.sourceTreeDirty !== false ||
    sourceTreeDirty
  ) {
    throw new Error(
      "Prepared desktop resources do not match the clean version, commit, timestamp, platform, and architecture being packaged."
    );
  }
}

function releaseTrustMetadata({ platform, filename, signed, notarized = false, productionTrusted = false }) {
  const warning =
    platform === "macos" && (!signed || !notarized)
      ? "Unsigned development distribution. macOS may display a security warning. This build has not yet been Apple notarized."
      : platform === "windows" && !signed
        ? "Unsigned Windows build. Windows SmartScreen may show a warning because an Authenticode certificate has not yet been configured."
        : null;
  return {
    filename,
    platform,
    architecture: buildArchitecture(platform),
    available: true,
    signed,
    notarized,
    checksumVerified: true,
    metadataValid: true,
    productionRecommended: productionTrusted,
    warning,
    blockedReason: null,
    releaseChannel: productionTrusted ? "stable" : "internal",
    buildCommit,
    buildTimestamp,
  };
}

function hasAppleIdNotaryCredentials() {
  return Boolean(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID);
}

function hasAppleApiNotaryCredentials() {
  return Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_ISSUER && process.env.APPLE_API_KEY_PATH);
}

function requirePublicMacCredentials() {
  const hasSigningIdentity = Boolean(process.env.BEZGROW_MAC_SIGNING_IDENTITY || process.env.APPLE_CERTIFICATE);
  const hasNotaryCredentials = hasAppleIdNotaryCredentials() || hasAppleApiNotaryCredentials();

  if (!hasSigningIdentity || !hasNotaryCredentials) {
    throw new Error(
      [
        "Public macOS builds must be Developer ID signed and notarized.",
        "Set BEZGROW_MAC_SIGNING_IDENTITY to a valid 'Developer ID Application: ...' identity or provide APPLE_CERTIFICATE/APPLE_CERTIFICATE_PASSWORD.",
        "Also set notarization credentials: APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH.",
      ].join("\n")
    );
  }
}

function configureMacSigning(config) {
  config.bundle ??= {};
  config.bundle.macOS ??= {};

  if (process.platform !== "darwin") {
    return config;
  }

  if (publicMacBuild) {
    requirePublicMacCredentials();
    config.bundle.macOS.hardenedRuntime = true;
    delete config.bundle.macOS.signingIdentity;

    if (process.env.BEZGROW_MAC_SIGNING_IDENTITY) {
      config.bundle.macOS.signingIdentity = process.env.BEZGROW_MAC_SIGNING_IDENTITY;
    }

    if (process.env.BEZGROW_MAC_PROVIDER_SHORT_NAME) {
      config.bundle.macOS.providerShortName = process.env.BEZGROW_MAC_PROVIDER_SHORT_NAME;
    }
  } else {
    config.bundle.macOS.signingIdentity = "-";
    config.bundle.macOS.hardenedRuntime = false;
  }

  return config;
}

function configureWindowsSigning(config) {
  if (process.platform !== "win32") return config;

  const certificateThumbprint = process.env.BEZGROW_WINDOWS_CERTIFICATE_THUMBPRINT || "";
  if (publicWindowsBuild && !certificateThumbprint) {
    throw new Error(
      "Public Windows builds require BEZGROW_WINDOWS_CERTIFICATE_THUMBPRINT for Authenticode signing."
    );
  }
  if (!certificateThumbprint) return config;

  config.bundle ??= {};
  config.bundle.windows ??= {};
  config.bundle.windows.certificateThumbprint = certificateThumbprint;
  config.bundle.windows.digestAlgorithm = "sha256";
  config.bundle.windows.timestampUrl =
    process.env.BEZGROW_WINDOWS_TIMESTAMP_URL || "http://timestamp.digicert.com";
  return config;
}

function configureUpdater(config) {
  const publicKey = (process.env.BEZGROW_UPDATER_PUBLIC_KEY || "").trim();
  const privateKey = (process.env.TAURI_SIGNING_PRIVATE_KEY || "").trim();
  const publicBuild = publicMacBuild || publicWindowsBuild;
  if (publicBuild && (!publicKey || !privateKey)) {
    throw new Error(
      "Public desktop builds require BEZGROW_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY so every updater artifact is signed."
    );
  }

  config.bundle ??= {};
  config.plugins ??= {};
  if (!publicKey || !privateKey) {
    config.bundle.createUpdaterArtifacts = false;
    delete config.plugins.updater;
    return config;
  }

  const updateOrigin = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com").replace(/\/$/, "");
  config.bundle.createUpdaterArtifacts = true;
  config.plugins.updater = {
    pubkey: publicKey,
    endpoints: [`${updateOrigin}/api/desktop-updater/{{target}}/{{arch}}/{{current_version}}`],
    windows: { installMode: "passive" },
  };
  return config;
}

function tauriBuildEnv() {
  const env = { ...process.env };

  if (process.platform === "darwin" && !env.CI) {
    env.CI = "true";
  }
  if (targetTriple) {
    env.BEZGROW_DESKTOP_TARGET = targetTriple;
  }
  env.BEZGROW_BUILD_COMMIT = buildCommit;
  env.BEZGROW_BUILD_TIMESTAMP = buildTimestamp;
  env.BEZGROW_BUILD_CHANNEL = publicMacBuild || publicWindowsBuild ? "stable" : "internal";

  return env;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: tauriBuildEnv(),
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function latestBundleFile(directory, predicate) {
  if (!existsSync(directory)) return "";

  const file = readdirSync(directory)
    .filter(predicate)
    .sort()
    .at(-1);

  return file ? join(directory, file) : "";
}

function verifyPublicMacDmg() {
  if (!publicMacBuild || process.platform !== "darwin") return;

  const dmgDir = join(releaseRoot, "bundle", "dmg");
  const dmgPath = latestBundleFile(dmgDir, (file) => file.startsWith("Bezgrow_") && file.endsWith(".dmg"));

  if (!existsSync(dmgPath)) {
    throw new Error(`Expected notarized DMG was not found in ${dmgDir}`);
  }

  const spctl = spawnSync("spctl", ["-a", "-vv", "--type", "open", dmgPath], {
    cwd: root,
    encoding: "utf8",
  });

  if (spctl.status !== 0) {
    throw new Error(`Gatekeeper rejected the generated DMG.\n${spctl.stderr || spctl.stdout}`);
  }

  mkdirSync(publicDownloadsDir, { recursive: true });
  copyFileSync(dmgPath, publicMacDmg);

  const bytes = readFileSync(publicMacDmg);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const generatedAt = new Date().toISOString();
  writeFileSync(
    publicMacReleaseManifest,
    JSON.stringify(
      {
        file: publicMacDownloadPath,
        downloadUrl: publicMacDownloadPath,
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "macos",
          filename: publicMacFilename,
          signed: true,
          notarized: true,
          productionTrusted: true,
        }),
        generatedAt,
      },
      null,
      2
    )
  );
  writeDesktopReleaseManifest({
    mac: {
      file: publicMacDownloadPath,
      downloadUrl: publicMacDownloadPath,
      version: packageVersion,
      sha256,
      size: bytes.length,
      ...releaseTrustMetadata({
        platform: "macos",
        filename: publicMacFilename,
        signed: true,
        notarized: true,
        productionTrusted: true,
      }),
      generatedAt,
    },
  });
}

function verifyAuthenticodeSignature(path) {
  const verification = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AuthenticodeSignature -LiteralPath $args[0]).Status",
      path,
    ],
    { cwd: root, encoding: "utf8" }
  );
  return verification.status === 0 && verification.stdout.trim() === "Valid";
}

function writeDesktopReleaseManifest(partialManifest) {
  const existing = existsSync(desktopReleaseManifest)
    ? JSON.parse(readFileSync(desktopReleaseManifest, "utf8"))
    : {};
  for (const key of [
    "mac",
    "windows",
    "windowsMsi",
    "windowsMsix",
    "windowsArm64",
    "windowsArm64Msi",
    "windowsArm64Msix",
    "windowsPortable",
    "windowsPortableZip",
    "windowsArm64Portable",
    "windowsArm64PortableZip",
  ]) {
    if (existing[key]?.version && existing[key].version !== packageVersion) {
      delete existing[key];
    }
  }

  mkdirSync(publicDownloadsDir, { recursive: true });
  writeFileSync(
    desktopReleaseManifest,
    `${JSON.stringify(
      {
        ...existing,
        version: packageVersion,
        releaseNotes: [releaseNotes],
        generatedAt: new Date().toISOString(),
        ...partialManifest,
      },
      null,
      2
    )}\n`
  );
}

function writeInstallerReleaseManifest(path, payload) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function verifyPublicWindowsInstaller() {
  if (!publicWindowsBuild) return;

  if (process.platform !== "win32") {
    throw new Error("Public Windows builds must run on Windows.");
  }

  const nsisDir = join(releaseRoot, "bundle", "nsis");
  const msiDir = join(releaseRoot, "bundle", "msi");
  const windowsPath = latestBundleFile(nsisDir, (file) => file.startsWith("Bezgrow_") && file.endsWith(".exe"));
  const windowsMsiPath = latestBundleFile(msiDir, (file) => file.startsWith("Bezgrow_") && file.endsWith(".msi"));

  if (!existsSync(windowsPath)) {
    throw new Error(`Expected Windows installer was not found in ${nsisDir}`);
  }
  if (!existsSync(windowsMsiPath)) {
    throw new Error(`Expected Windows MSI was not found in ${msiDir}`);
  }
  if (!verifyAuthenticodeSignature(windowsPath) || !verifyAuthenticodeSignature(windowsMsiPath)) {
    throw new Error("Public Windows installers must have a valid Authenticode signature.");
  }

  mkdirSync(publicDownloadsDir, { recursive: true });
  copyFileSync(windowsPath, publicWindowsExe);
  copyFileSync(windowsMsiPath, publicWindowsMsi);

  const exeBytes = readFileSync(publicWindowsExe);
  const msiBytes = readFileSync(publicWindowsMsi);
  const exeSha256 = createHash("sha256").update(exeBytes).digest("hex");
  const msiSha256 = createHash("sha256").update(msiBytes).digest("hex");
  const generatedAt = new Date().toISOString();
  const signed = true;

  writeInstallerReleaseManifest(publicWindowsExeReleaseManifest, {
    file: publicWindowsExeDownloadPath,
    downloadUrl: publicWindowsExeDownloadPath,
    version: packageVersion,
    sha256: exeSha256,
    size: exeBytes.length,
    ...releaseTrustMetadata({
      platform: "windows",
      filename: publicWindowsExeFilename,
      signed,
      productionTrusted: true,
    }),
    generatedAt,
  });
  writeInstallerReleaseManifest(publicWindowsMsiReleaseManifest, {
    file: publicWindowsMsiDownloadPath,
    downloadUrl: publicWindowsMsiDownloadPath,
    version: packageVersion,
    sha256: msiSha256,
    size: msiBytes.length,
    ...releaseTrustMetadata({
      platform: "windows",
      filename: publicWindowsMsiFilename,
      signed,
      productionTrusted: true,
    }),
    generatedAt,
  });
  writeDesktopReleaseManifest({
    windows: {
      file: publicWindowsExeDownloadPath,
      downloadUrl: publicWindowsExeDownloadPath,
      version: packageVersion,
      sha256: exeSha256,
      size: exeBytes.length,
      ...releaseTrustMetadata({
        platform: "windows",
        filename: publicWindowsExeFilename,
        signed,
        productionTrusted: true,
      }),
      generatedAt,
    },
    windowsMsi: {
      file: publicWindowsMsiDownloadPath,
      downloadUrl: publicWindowsMsiDownloadPath,
      version: packageVersion,
      sha256: msiSha256,
      size: msiBytes.length,
      ...releaseTrustMetadata({
        platform: "windows",
        filename: publicWindowsMsiFilename,
        signed,
        productionTrusted: true,
      }),
      generatedAt,
    },
  });
}

function copyGeneratedInstallersForDownloads() {
  const dmgPath = latestBundleFile(
    join(releaseRoot, "bundle", "dmg"),
    (file) => file.startsWith("Bezgrow_") && file.endsWith(".dmg")
  );
  const windowsExePath = latestBundleFile(
    join(releaseRoot, "bundle", "nsis"),
    (file) => file.startsWith("Bezgrow_") && file.endsWith(".exe")
  );
  const windowsMsiPath = latestBundleFile(
    join(releaseRoot, "bundle", "msi"),
    (file) => file.startsWith("Bezgrow_") && file.endsWith(".msi")
  );

  mkdirSync(publicDownloadsDir, { recursive: true });

  if (publicMacBuild && existsSync(dmgPath)) {
    copyFileSync(dmgPath, publicMacDmg);
    const bytes = readFileSync(publicMacDmg);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const generatedAt = new Date().toISOString();
    const notarized = Boolean(publicMacBuild);
    const signed = Boolean(publicMacBuild);
    writeInstallerReleaseManifest(
      publicMacReleaseManifest,
      {
        file: publicMacDownloadPath,
        downloadUrl: publicMacDownloadPath,
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "macos",
          filename: publicMacFilename,
          signed,
          notarized,
          productionTrusted: Boolean(publicMacBuild),
        }),
        generatedAt,
      }
    );
    writeDesktopReleaseManifest({
      mac: {
        file: publicMacDownloadPath,
        downloadUrl: publicMacDownloadPath,
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "macos",
          filename: publicMacFilename,
          signed,
          notarized,
          productionTrusted: Boolean(publicMacBuild),
        }),
        generatedAt,
      },
    });
    console.log(`Copied ${dmgPath} to ${publicMacDmg}`);
  }

  if (publicWindowsBuild && existsSync(windowsExePath)) {
    copyFileSync(windowsExePath, publicWindowsExe);
    const bytes = readFileSync(publicWindowsExe);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const generatedAt = new Date().toISOString();
    const signed = publicWindowsBuild ? verifyAuthenticodeSignature(windowsExePath) : envBoolean("BEZGROW_WINDOWS_SIGNED");
    writeInstallerReleaseManifest(publicWindowsExeReleaseManifest, {
      file: publicWindowsExeDownloadPath,
      downloadUrl: publicWindowsExeDownloadPath,
      version: packageVersion,
      sha256,
      size: bytes.length,
      ...releaseTrustMetadata({
        platform: "windows",
        filename: publicWindowsExeFilename,
        signed,
        productionTrusted: Boolean(publicWindowsBuild && signed),
      }),
      generatedAt,
    });
    writeDesktopReleaseManifest({
      windows: {
        file: publicWindowsExeDownloadPath,
        downloadUrl: publicWindowsExeDownloadPath,
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "windows",
          filename: publicWindowsExeFilename,
          signed,
          productionTrusted: Boolean(publicWindowsBuild && signed),
        }),
        generatedAt,
      },
    });
    console.log(`Copied ${windowsExePath} to ${publicWindowsExe}`);
  }

  if (publicWindowsBuild && existsSync(windowsMsiPath)) {
    copyFileSync(windowsMsiPath, publicWindowsMsi);
    const bytes = readFileSync(publicWindowsMsi);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const generatedAt = new Date().toISOString();
    const signed = publicWindowsBuild ? verifyAuthenticodeSignature(windowsMsiPath) : envBoolean("BEZGROW_WINDOWS_SIGNED");
    writeInstallerReleaseManifest(publicWindowsMsiReleaseManifest, {
      file: publicWindowsMsiDownloadPath,
      downloadUrl: publicWindowsMsiDownloadPath,
      version: packageVersion,
      sha256,
      size: bytes.length,
      ...releaseTrustMetadata({
        platform: "windows",
        filename: publicWindowsMsiFilename,
        signed,
        productionTrusted: Boolean(publicWindowsBuild && signed),
      }),
      generatedAt,
    });
    writeDesktopReleaseManifest({
      windowsMsi: {
        file: publicWindowsMsiDownloadPath,
        downloadUrl: publicWindowsMsiDownloadPath,
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "windows",
          filename: publicWindowsMsiFilename,
          signed,
          productionTrusted: Boolean(publicWindowsBuild && signed),
        }),
        generatedAt,
      },
    });
    console.log(`Copied ${windowsMsiPath} to ${publicWindowsMsi}`);
  }
}

mkdirSync(generatedConfigDir, { recursive: true });
// Only packaging output is removed. Cargo dependency caches remain intact, and
// no application-support, SQLite, licence, logo, settings, or backup path is
// under this repository target directory.
rmSync(join(releaseRoot, "bundle"), { recursive: true, force: true });
const config = configureUpdater(
  configureWindowsSigning(
    configureMacSigning(JSON.parse(readFileSync(tauriConfigPath, "utf8")))
  )
);
config.version = packageVersion;
if (process.env.BEZGROW_DESKTOP_PREPARED === "1") {
  config.build ??= {};
  config.build.beforeBuildCommand = "";
}
writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);

if (!existsSync(tauriCli)) {
  throw new Error(`The project-local Tauri CLI is missing: ${tauriCli}`);
}
run(process.execPath, [
  tauriCli,
  "build",
  "--config",
  generatedConfigPath,
  ...preserveMacAppBundle(tauriArgs),
]);
if (process.platform === "win32") {
  run(process.execPath, [
    join(root, "scripts", "build-windows-portable.mjs"),
    ...(targetTriple ? ["--target", targetTriple] : []),
  ]);
}
verifyPublicMacDmg();
verifyPublicWindowsInstaller();
copyGeneratedInstallersForDownloads();
