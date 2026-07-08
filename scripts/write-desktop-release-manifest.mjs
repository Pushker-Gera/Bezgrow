import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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
  const value = readArg(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readNumberArg(name) {
  const value = Number(readArg(name));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readExistingManifest() {
  if (!existsSync(manifestPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function buildInstaller(prefix, trustKey, version) {
  const url = readArg(`--${prefix}-url`);
  const file = readArg(`--${prefix}-file`);
  const existingPath = file ? (isAbsolute(file) ? file : join(root, file)) : "";
  const hasLocalFile = existingPath && existsSync(existingPath);
  const size = hasLocalFile ? statSync(existingPath).size : readNumberArg(`--${prefix}-size`);
  const hash = hasLocalFile ? sha256(existingPath) : readArg(`--${prefix}-sha256`);

  if (!url && !file) return null;

  return {
    url,
    file: url ? undefined : file.replace(/^public\//, "/"),
    version,
    size,
    sha256: hash || undefined,
    [trustKey]: readBooleanArg(`--${prefix}-${trustKey}`),
    generatedAt: new Date().toISOString(),
  };
}

const existingManifest = readExistingManifest();
const version = readArg("--version") || existingManifest.version || packageJson.version;
const mac = buildInstaller("mac", "notarized", version);
const windows = buildInstaller("windows", "signed", version);

const nextManifest = {
  ...existingManifest,
  version,
  ...(mac ? { mac } : {}),
  ...(windows ? { windows } : {}),
};

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
console.log(`Wrote ${manifestPath}`);
