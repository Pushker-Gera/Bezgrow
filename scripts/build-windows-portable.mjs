import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  throw new Error("Windows portable releases must be assembled on Windows.");
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const targetIndex = args.indexOf("--target");
const targetTriple = targetIndex >= 0 ? args[targetIndex + 1] || "" : "";
const architecture = targetTriple.startsWith("aarch64") || process.arch === "arm64" ? "arm64" : "x64";
const releaseRoot = targetTriple
  ? join(root, "src-tauri", "target", targetTriple, "release")
  : join(root, "src-tauri", "target", "release");
const bundleDirectory = join(releaseRoot, "bundle", "portable");
const portableDirectory = join(bundleDirectory, `Bezgrow-windows-${architecture}`);
const applicationBinary = join(releaseRoot, "Bezgrow.exe");
const nodeBinary = join(root, "desktop-runtime", "node", "node.exe");
const nextServer = join(root, "desktop-runtime", "next-server");
const zipPath = join(bundleDirectory, `Bezgrow-windows-${architecture}-portable.zip`);
const portableExePath = join(bundleDirectory, `Bezgrow-windows-${architecture}-portable.exe`);
const nsisScript = join(root, "src-tauri", "windows", "portable.nsi");
const iconPath = join(root, "src-tauri", "icons", "icon.ico");

for (const requiredPath of [applicationBinary, nodeBinary, nextServer, nsisScript, iconPath]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Portable Windows release input is missing: ${requiredPath}`);
  }
}

rmSync(portableDirectory, { recursive: true, force: true });
mkdirSync(join(portableDirectory, "node"), { recursive: true });
cpSync(applicationBinary, join(portableDirectory, "Bezgrow.exe"));
cpSync(nodeBinary, join(portableDirectory, "node", "node.exe"));
cpSync(nextServer, join(portableDirectory, "next-server"), { recursive: true });

rmSync(zipPath, { force: true });
const zip = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Compress-Archive -LiteralPath $env:BEZGROW_PORTABLE_SOURCE -DestinationPath $env:BEZGROW_PORTABLE_ZIP -CompressionLevel Optimal -Force",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BEZGROW_PORTABLE_SOURCE: portableDirectory,
      BEZGROW_PORTABLE_ZIP: zipPath,
    },
  }
);
if (zip.status !== 0 || !existsSync(zipPath)) {
  throw new Error(`Unable to create the Windows portable ZIP.\n${zip.stderr || zip.stdout}`);
}

rmSync(portableExePath, { force: true });
const makensis = spawnSync(
  "makensis.exe",
  [
    `/DAPP_SOURCE=${portableDirectory}`,
    `/DOUTPUT_FILE=${portableExePath}`,
    `/DICON_FILE=${iconPath}`,
    nsisScript,
  ],
  { cwd: root, encoding: "utf8" }
);
if (makensis.status !== 0 || !existsSync(portableExePath)) {
  throw new Error(`Unable to create the Windows portable executable.\n${makensis.stderr || makensis.stdout}`);
}

const certificateThumbprint = process.env.BEZGROW_WINDOWS_CERTIFICATE_THUMBPRINT || "";
let signed = false;
if (certificateThumbprint) {
  const windowsKitsBin = join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Windows Kits",
    "10",
    "bin"
  );
  const installedSignTool = existsSync(windowsKitsBin)
    ? readdirSync(windowsKitsBin)
        .sort()
        .reverse()
        .map((version) => join(windowsKitsBin, version, "x64", "signtool.exe"))
        .find((candidate) => existsSync(candidate))
    : undefined;
  const signTool = installedSignTool || "signtool.exe";
  const sign = spawnSync(
    signTool,
    [
      "sign",
      "/sha1",
      certificateThumbprint,
      "/fd",
      "sha256",
      "/tr",
      process.env.BEZGROW_WINDOWS_TIMESTAMP_URL || "http://timestamp.digicert.com",
      "/td",
      "sha256",
      portableExePath,
    ],
    { cwd: root, encoding: "utf8" }
  );
  if (sign.status !== 0) {
    throw new Error(`Unable to sign the Windows portable executable.\n${sign.stderr || sign.stdout}`);
  }

  const verification = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AuthenticodeSignature -LiteralPath $args[0]).Status",
      portableExePath,
    ],
    { cwd: root, encoding: "utf8" }
  );
  if (verification.status !== 0 || verification.stdout.trim() !== "Valid") {
    throw new Error(
      `The Windows portable executable failed Authenticode verification.\n${
        verification.stderr || verification.stdout
      }`
    );
  }
  signed = true;
}

const manifest = {
  version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  architecture,
  executable: portableExePath,
  zip: zipPath,
  signed,
};
writeFileSync(
  join(bundleDirectory, `Bezgrow-windows-${architecture}-portable.json`),
  `${JSON.stringify(manifest, null, 2)}\n`
);
console.log(`Created ${portableExePath}`);
console.log(`Created ${zipPath}`);
