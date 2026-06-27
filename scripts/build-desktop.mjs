import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tauriConfigPath = join(root, "src-tauri", "tauri.conf.json");
const generatedConfigDir = join(root, "src-tauri");
const generatedConfigPath = join(generatedConfigDir, "tauri.generated.conf.json");
const publicDownloadsDir = join(root, "public", "downloads");
const publicMacDmg = join(publicDownloadsDir, "Bezgrow-mac.dmg");
const publicMacReleaseManifest = join(root, "public", "downloads", "Bezgrow-mac.dmg.release.json");

const passthroughArgs = process.argv.slice(2);
const publicMacFlag = "--public-mac";
const publicMacBuild = process.env.BEZGROW_MAC_PUBLIC_BUILD === "1" || passthroughArgs.includes(publicMacFlag);
const tauriArgs = passthroughArgs.filter((arg) => arg !== publicMacFlag);

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

function verifyPublicMacDmg() {
  if (!publicMacBuild || process.platform !== "darwin") return;

  const dmgDir = join(root, "src-tauri", "target", "release", "bundle", "dmg");
  const dmgFile = readdirSync(dmgDir)
    .filter((file) => file.startsWith("Bezgrow_") && file.endsWith(".dmg"))
    .sort()
    .at(-1);
  const dmgPath = dmgFile ? join(dmgDir, dmgFile) : "";

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
  writeFileSync(
    publicMacReleaseManifest,
    JSON.stringify(
      {
        file: "/downloads/Bezgrow-mac.dmg",
        version: "0.1.0",
        sha256,
        notarized: true,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

mkdirSync(generatedConfigDir, { recursive: true });
const config = configureMacSigning(JSON.parse(readFileSync(tauriConfigPath, "utf8")));
writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);

run("tauri", ["build", "--config", generatedConfigPath, ...tauriArgs]);
verifyPublicMacDmg();
