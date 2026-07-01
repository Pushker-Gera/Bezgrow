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
const desktopReleaseManifest = join(publicDownloadsDir, "desktop-release.json");

const passthroughArgs = process.argv.slice(2);
const publicMacFlag = "--public-mac";
const publicWindowsFlag = "--public-windows";
const publicMacBuild = process.env.BEZGROW_MAC_PUBLIC_BUILD === "1" || passthroughArgs.includes(publicMacFlag);
const publicWindowsBuild = process.env.BEZGROW_WINDOWS_PUBLIC_BUILD === "1" || passthroughArgs.includes(publicWindowsFlag);
const tauriArgs = passthroughArgs.filter((arg) => arg !== publicMacFlag && arg !== publicWindowsFlag);

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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
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

  const dmgDir = join(root, "src-tauri", "target", "release", "bundle", "dmg");
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
        version: packageVersion,
        sha256,
        size: bytes.length,
        notarized: true,
        generatedAt,
      },
      null,
      2
    )
  );
  writeDesktopReleaseManifest({
    mac: {
      file: "/downloads/Bezgrow-mac.dmg",
      version: packageVersion,
      sha256,
      size: bytes.length,
      notarized: true,
      generatedAt,
    },
  });
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

function verifyPublicWindowsInstaller() {
  if (!publicWindowsBuild) return;

  if (process.platform !== "win32") {
    throw new Error("Public Windows builds must run on Windows.");
  }

  const nsisDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
  const windowsPath = latestBundleFile(nsisDir, (file) => file.startsWith("Bezgrow_") && file.endsWith(".exe"));

  if (!existsSync(windowsPath)) {
    throw new Error(`Expected Windows installer was not found in ${nsisDir}`);
  }

  mkdirSync(publicDownloadsDir, { recursive: true });
  copyFileSync(windowsPath, publicWindowsExe);

  const bytes = readFileSync(publicWindowsExe);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeDesktopReleaseManifest({
    windows: {
      file: "/downloads/Bezgrow-windows.exe",
      version: packageVersion,
      sha256,
      size: bytes.length,
      signed: Boolean(process.env.BEZGROW_WINDOWS_SIGNED === "1"),
      generatedAt: new Date().toISOString(),
    },
  });
}

function copyGeneratedInstallersForDownloads() {
  const dmgPath = latestBundleFile(
    join(root, "src-tauri", "target", "release", "bundle", "dmg"),
    (file) => file.startsWith("Bezgrow_") && file.endsWith(".dmg")
  );
  const windowsExePath = latestBundleFile(
    join(root, "src-tauri", "target", "release", "bundle", "nsis"),
    (file) => file.startsWith("Bezgrow_") && file.endsWith(".exe")
  );
  const windowsMsiPath = latestBundleFile(
    join(root, "src-tauri", "target", "release", "bundle", "msi"),
    (file) => file.startsWith("Bezgrow_") && file.endsWith(".msi")
  );

  mkdirSync(publicDownloadsDir, { recursive: true });

  if (existsSync(dmgPath)) {
    copyFileSync(dmgPath, publicMacDmg);
    const bytes = readFileSync(publicMacDmg);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const generatedAt = new Date().toISOString();
    const notarized = Boolean(publicMacBuild);
    writeFileSync(
      publicMacReleaseManifest,
      JSON.stringify(
        {
          file: "/downloads/Bezgrow-mac.dmg",
          version: packageVersion,
          sha256,
          size: bytes.length,
          notarized,
          generatedAt,
        },
        null,
        2
      )
    );
    writeDesktopReleaseManifest({
      mac: {
        file: "/downloads/Bezgrow-mac.dmg",
        version: packageVersion,
        sha256,
        size: bytes.length,
        notarized,
        generatedAt,
      },
    });
    console.log(`Copied ${dmgPath} to ${publicMacDmg}`);
  }

  if (existsSync(windowsExePath)) {
    copyFileSync(windowsExePath, publicWindowsExe);
    const bytes = readFileSync(publicWindowsExe);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeDesktopReleaseManifest({
      windows: {
        file: "/downloads/Bezgrow-windows.exe",
        version: packageVersion,
        sha256,
        size: bytes.length,
        signed: Boolean(process.env.BEZGROW_WINDOWS_SIGNED === "1"),
        generatedAt: new Date().toISOString(),
      },
    });
    console.log(`Copied ${windowsExePath} to ${publicWindowsExe}`);
  }

  if (existsSync(windowsMsiPath)) {
    copyFileSync(windowsMsiPath, publicWindowsMsi);
    const bytes = readFileSync(publicWindowsMsi);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeDesktopReleaseManifest({
      windows: {
        file: "/downloads/Bezgrow-windows.msi",
        version: packageVersion,
        sha256,
        size: bytes.length,
        signed: Boolean(process.env.BEZGROW_WINDOWS_SIGNED === "1"),
        generatedAt: new Date().toISOString(),
      },
    });
    console.log(`Copied ${windowsMsiPath} to ${publicWindowsMsi}`);
  }
}

mkdirSync(generatedConfigDir, { recursive: true });
const config = configureMacSigning(JSON.parse(readFileSync(tauriConfigPath, "utf8")));
writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);

run("tauri", ["build", "--config", generatedConfigPath, ...tauriArgs]);
verifyPublicMacDmg();
verifyPublicWindowsInstaller();
copyGeneratedInstallersForDownloads();
