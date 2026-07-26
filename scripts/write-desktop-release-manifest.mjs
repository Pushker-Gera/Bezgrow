import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "public", "downloads", "desktop-release.json");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  return args[index + 1] || "";
}

function readBooleanArg(name) {
  return /^(1|true|yes)$/i.test(readArg(name));
}

function readNumberArg(name) {
  const value = Number(readArg(name));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readExistingManifest() {
  if (!existsSync(manifestPath)) return {};
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function installerWarning(platform, signed, notarized) {
  if (platform === "macos" && (!signed || !notarized)) {
    return "Internal/testing build: this macOS installer is not notarized and macOS may show a security warning.";
  }
  if (platform === "windows" && !signed) {
    return "Internal/testing build: Windows SmartScreen may display a warning because this installer is not code-signed.";
  }
  return null;
}

function buildInstaller(prefix, version, architecture) {
  const platform = prefix.startsWith("mac") ? "macos" : "windows";
  const url = readArg(`--${prefix}-url`);
  const downloadUrl = readArg(`--${prefix}-download-url`) || url;
  const file = readArg(`--${prefix}-file`);
  const existingPath = file ? (isAbsolute(file) ? file : join(root, file)) : "";
  const hasLocalFile = Boolean(existingPath && existsSync(existingPath));
  const size = hasLocalFile ? statSync(existingPath).size : readNumberArg(`--${prefix}-size`);
  const hash = hasLocalFile ? sha256(existingPath) : readArg(`--${prefix}-sha256`);
  if (!downloadUrl && !file) return null;

  const filename =
    readArg(`--${prefix}-filename`) ||
    basename((downloadUrl || file).split("?")[0]);
  const notarized =
    platform === "macos" && readBooleanArg(`--${prefix}-notarized`);
  const signed =
    readBooleanArg(`--${prefix}-signed`) || notarized;
  const checksumVerified =
    hasLocalFile || readBooleanArg(`--${prefix}-checksum-verified`);
  const metadataValid = Boolean(
    version &&
      architecture &&
      filename &&
      size &&
      /^[a-f0-9]{64}$/i.test(hash || "")
  );
  const releaseChannel =
    readArg(`--${prefix}-channel`) ||
    readArg("--channel") ||
    (signed && (platform === "windows" || notarized) ? "stable" : "internal");
  const productionRecommended =
    signed &&
    (platform === "windows" || notarized) &&
    checksumVerified &&
    metadataValid &&
    releaseChannel === "stable";

  return {
    downloadUrl,
    url: downloadUrl,
    ...(downloadUrl ? {} : { file: file.replace(/^public\//, "/") }),
    filename,
    version,
    platform,
    architecture,
    size,
    sha256: hash || undefined,
    available: Boolean(size && hash),
    signed,
    notarized,
    checksumVerified,
    metadataValid,
    productionRecommended,
    warning: installerWarning(platform, signed, notarized),
    blockedReason: size && hash ? null : "Installer size or SHA-256 is missing.",
    releaseChannel,
    generatedAt: new Date().toISOString(),
  };
}

const existingManifest = readBooleanArg("--replace") ? {} : readExistingManifest();
const version = readArg("--version") || existingManifest.version || packageJson.version;
const installers = {
  mac: buildInstaller("mac", version, readArg("--mac-architecture")),
  macX64: buildInstaller("mac-x64", version, "x64"),
  windows: buildInstaller("windows", version, "x64"),
  windowsMsi: buildInstaller("windows-msi", version, "x64"),
  windowsMsix: buildInstaller("windows-msix", version, "x64"),
  windowsArm64: buildInstaller("windows-arm64", version, "arm64"),
  windowsArm64Msi: buildInstaller("windows-arm64-msi", version, "arm64"),
  windowsArm64Msix: buildInstaller("windows-arm64-msix", version, "arm64"),
  windowsPortable: buildInstaller("windows-portable", version, "x64"),
  windowsPortableZip: buildInstaller("windows-portable-zip", version, "x64"),
  windowsArm64Portable: buildInstaller("windows-arm64-portable", version, "arm64"),
  windowsArm64PortableZip: buildInstaller("windows-arm64-portable-zip", version, "arm64"),
};

const nextManifest = { ...existingManifest, version };
for (const [key, installer] of Object.entries(installers)) {
  if (installer) nextManifest[key] = installer;
}

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
console.log(`Wrote ${manifestPath}`);
