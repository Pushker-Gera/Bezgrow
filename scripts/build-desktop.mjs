import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageVersion = packageJson.version;
const tauriConfigPath = join(root, "src-tauri", "tauri.conf.json");
const generatedConfigDir = join(root, "src-tauri");
const generatedConfigPath = join(generatedConfigDir, "tauri.generated.conf.json");
const publicDownloadsDir = join(root, "public", "downloads");
const publicMacDmg = join(publicDownloadsDir, "Bezgrow-mac.dmg");
const publicMacReleaseManifest = join(root, "public", "downloads", "Bezgrow-mac.dmg.release.json");
const publicWindowsExe = join(publicDownloadsDir, "Bezgrow-windows.exe");
const publicWindowsMsi = join(publicDownloadsDir, "Bezgrow-windows.msi");
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

function envBoolean(name) {
  const value = (process.env[name] || "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function buildArchitecture() {
  if (/aarch64|arm64/i.test(targetTriple)) return "arm64";
  if (/x86_64|x64|amd64/i.test(targetTriple)) return "x64";
  return process.arch === "arm64" ? "arm64" : "x64";
}

function releaseTrustMetadata({ platform, filename, signed, notarized = false, productionTrusted = false }) {
  const warning =
    platform === "macos" && (!signed || !notarized)
      ? "Internal/testing build: this macOS installer is not notarized and macOS may show a security warning."
      : platform === "windows" && !signed
        ? "Internal/testing build: Windows SmartScreen may display a warning because this installer is not code-signed."
        : null;
  return {
    filename,
    platform,
    architecture: buildArchitecture(),
    available: true,
    signed,
    notarized,
    checksumVerified: true,
    metadataValid: true,
    productionRecommended: productionTrusted,
    warning,
    blockedReason: null,
    releaseChannel: productionTrusted ? "stable" : "internal",
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

function tauriBuildEnv() {
  const env = { ...process.env };

  if (process.platform === "darwin" && !env.CI) {
    env.CI = "true";
  }
  if (targetTriple) {
    env.BEZGROW_DESKTOP_TARGET = targetTriple;
  }

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
        file: "/downloads/Bezgrow-mac.dmg",
        downloadUrl: "/downloads/Bezgrow-mac.dmg",
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "macos",
          filename: "Bezgrow-mac.dmg",
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
      file: "/downloads/Bezgrow-mac.dmg",
      downloadUrl: "/downloads/Bezgrow-mac.dmg",
      version: packageVersion,
      sha256,
      size: bytes.length,
      ...releaseTrustMetadata({
        platform: "macos",
        filename: "Bezgrow-mac.dmg",
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

  mkdirSync(publicDownloadsDir, { recursive: true });
  writeFileSync(
    desktopReleaseManifest,
    `${JSON.stringify(
      {
        ...existing,
        version: packageVersion,
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
    file: "/downloads/Bezgrow-windows.exe",
    downloadUrl: "/downloads/Bezgrow-windows.exe",
    version: packageVersion,
    sha256: exeSha256,
    size: exeBytes.length,
    ...releaseTrustMetadata({
      platform: "windows",
      filename: "Bezgrow-windows.exe",
      signed,
      productionTrusted: true,
    }),
    generatedAt,
  });
  writeInstallerReleaseManifest(publicWindowsMsiReleaseManifest, {
    file: "/downloads/Bezgrow-windows.msi",
    downloadUrl: "/downloads/Bezgrow-windows.msi",
    version: packageVersion,
    sha256: msiSha256,
    size: msiBytes.length,
    ...releaseTrustMetadata({
      platform: "windows",
      filename: "Bezgrow-windows.msi",
      signed,
      productionTrusted: true,
    }),
    generatedAt,
  });
  writeDesktopReleaseManifest({
    windows: {
      file: "/downloads/Bezgrow-windows.exe",
      downloadUrl: "/downloads/Bezgrow-windows.exe",
      version: packageVersion,
      sha256: exeSha256,
      size: exeBytes.length,
      ...releaseTrustMetadata({
        platform: "windows",
        filename: "Bezgrow-windows.exe",
        signed,
        productionTrusted: true,
      }),
      generatedAt,
    },
    windowsMsi: {
      file: "/downloads/Bezgrow-windows.msi",
      downloadUrl: "/downloads/Bezgrow-windows.msi",
      version: packageVersion,
      sha256: msiSha256,
      size: msiBytes.length,
      ...releaseTrustMetadata({
        platform: "windows",
        filename: "Bezgrow-windows.msi",
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

  if (existsSync(dmgPath)) {
    copyFileSync(dmgPath, publicMacDmg);
    const bytes = readFileSync(publicMacDmg);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const generatedAt = new Date().toISOString();
    const notarized = Boolean(publicMacBuild);
    const signed = Boolean(publicMacBuild);
    writeInstallerReleaseManifest(
      publicMacReleaseManifest,
      {
        file: "/downloads/Bezgrow-mac.dmg",
        downloadUrl: "/downloads/Bezgrow-mac.dmg",
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "macos",
          filename: "Bezgrow-mac.dmg",
          signed,
          notarized,
          productionTrusted: Boolean(publicMacBuild),
        }),
        generatedAt,
      }
    );
    writeDesktopReleaseManifest({
      mac: {
        file: "/downloads/Bezgrow-mac.dmg",
        downloadUrl: "/downloads/Bezgrow-mac.dmg",
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "macos",
          filename: "Bezgrow-mac.dmg",
          signed,
          notarized,
          productionTrusted: Boolean(publicMacBuild),
        }),
        generatedAt,
      },
    });
    console.log(`Copied ${dmgPath} to ${publicMacDmg}`);
  }

  if (existsSync(windowsExePath)) {
    copyFileSync(windowsExePath, publicWindowsExe);
    const bytes = readFileSync(publicWindowsExe);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const generatedAt = new Date().toISOString();
    const signed = publicWindowsBuild ? verifyAuthenticodeSignature(windowsExePath) : envBoolean("BEZGROW_WINDOWS_SIGNED");
    writeInstallerReleaseManifest(publicWindowsExeReleaseManifest, {
      file: "/downloads/Bezgrow-windows.exe",
      downloadUrl: "/downloads/Bezgrow-windows.exe",
      version: packageVersion,
      sha256,
      size: bytes.length,
      ...releaseTrustMetadata({
        platform: "windows",
        filename: "Bezgrow-windows.exe",
        signed,
        productionTrusted: Boolean(publicWindowsBuild && signed),
      }),
      generatedAt,
    });
    writeDesktopReleaseManifest({
      windows: {
        file: "/downloads/Bezgrow-windows.exe",
        downloadUrl: "/downloads/Bezgrow-windows.exe",
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "windows",
          filename: "Bezgrow-windows.exe",
          signed,
          productionTrusted: Boolean(publicWindowsBuild && signed),
        }),
        generatedAt,
      },
    });
    console.log(`Copied ${windowsExePath} to ${publicWindowsExe}`);
  }

  if (existsSync(windowsMsiPath)) {
    copyFileSync(windowsMsiPath, publicWindowsMsi);
    const bytes = readFileSync(publicWindowsMsi);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const generatedAt = new Date().toISOString();
    const signed = publicWindowsBuild ? verifyAuthenticodeSignature(windowsMsiPath) : envBoolean("BEZGROW_WINDOWS_SIGNED");
    writeInstallerReleaseManifest(publicWindowsMsiReleaseManifest, {
      file: "/downloads/Bezgrow-windows.msi",
      downloadUrl: "/downloads/Bezgrow-windows.msi",
      version: packageVersion,
      sha256,
      size: bytes.length,
      ...releaseTrustMetadata({
        platform: "windows",
        filename: "Bezgrow-windows.msi",
        signed,
        productionTrusted: Boolean(publicWindowsBuild && signed),
      }),
      generatedAt,
    });
    writeDesktopReleaseManifest({
      windowsMsi: {
        file: "/downloads/Bezgrow-windows.msi",
        downloadUrl: "/downloads/Bezgrow-windows.msi",
        version: packageVersion,
        sha256,
        size: bytes.length,
        ...releaseTrustMetadata({
          platform: "windows",
          filename: "Bezgrow-windows.msi",
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
const config = configureWindowsSigning(
  configureMacSigning(JSON.parse(readFileSync(tauriConfigPath, "utf8")))
);
writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);

run("tauri", ["build", "--config", generatedConfigPath, ...tauriArgs]);
if (process.platform === "win32") {
  run(process.execPath, [
    join(root, "scripts", "build-windows-portable.mjs"),
    ...(targetTriple ? ["--target", targetTriple] : []),
  ]);
}
verifyPublicMacDmg();
verifyPublicWindowsInstaller();
copyGeneratedInstallersForDownloads();
