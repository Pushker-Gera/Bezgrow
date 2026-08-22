import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

const version = JSON.parse(readFileSync("package.json", "utf8")).version
const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
const root = mkdtempSync(join(tmpdir(), "bezgrow-release-verifier-"))
const crlfAlignmentRoot = `${root}-crlf-alignment`

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex")
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(filename) : [filename]
  })
}

function writeChecksums(directory) {
  const checksumFile = join(directory, "SHA256SUMS.txt")
  const lines = filesUnder(directory)
    .filter((filename) => filename !== checksumFile)
    .sort()
    .map((filename) => `${sha256(filename)}  ${filename}`)
  writeFileSync(checksumFile, `${lines.join("\n")}\n`)
}

function run(directory, extra = []) {
  return spawnSync(process.execPath, [
    "scripts/verify-release.mjs",
    version,
    "--root", directory,
    "--commit", commit,
    "--mode", "internal",
    ...extra,
  ], { encoding: "utf8" })
}

try {
  const mac = join(root, "mac")
  const windows = join(root, "windows-x64")
  mkdirSync(mac, { recursive: true })
  mkdirSync(windows, { recursive: true })

  const dmgName = `Bezgrow-${version}-arm64.dmg`
  const dmgPath = join(mac, dmgName)
  const dmg = Buffer.alloc(5 * 1024 * 1024)
  dmg.write("koly", dmg.length - 4, "ascii")
  writeFileSync(dmgPath, dmg)
  writeFileSync(join(mac, "mac-architecture.txt"), "arm64\n")
  writeFileSync(join(mac, "mac-signing-status.txt"), "false\n")
  writeFileSync(join(mac, "mac-notarization-status.txt"), "false\n")
  writeFileSync(join(mac, "mac-updater-status.txt"), "false\n")
  writeFileSync(join(mac, "mac-build.json"), JSON.stringify({
    version,
    platform: "macos",
    architecture: "arm64",
    sourceCommit: commit,
    builtAt: "2026-08-22T08:00:00.000Z",
    sourceTreeDirty: false,
    artifact: { filename: dmgName, bytes: statSync(dmgPath).size, sha256: sha256(dmgPath) },
  }))

  const exeName = `Bezgrow-Setup-${version}-x64.exe`
  const exePath = join(windows, exeName)
  const exe = Buffer.alloc(1024 * 1024)
  exe.write("MZ", 0, "ascii")
  exe.writeUInt32LE(0x80, 0x3c)
  exe.write("PE\u0000\u0000", 0x80, "binary")
  exe.writeUInt16LE(0x14c, 0x84)
  writeFileSync(exePath, exe)

  const msiName = `Bezgrow-${version}-x64.msi`
  const msiPath = join(windows, msiName)
  const msi = Buffer.alloc(1024 * 1024)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(msi)
  writeFileSync(msiPath, msi)
  writeFileSync(join(windows, "windows-signing-status.txt"), "unsigned\n")
  writeFileSync(join(windows, "windows-updater-status.txt"), "false\n")
  writeFileSync(join(windows, "windows-build.json"), JSON.stringify({
    version,
    platform: "windows",
    architecture: "x86_64",
    buildCommit: commit,
    builtAt: "2026-08-22T08:00:00.000Z",
    sourceTreeDirty: false,
    artifacts: [
      { kind: "nsis", filename: exeName, bytes: statSync(exePath).size, sha256: sha256(exePath) },
      { kind: "msi", filename: msiName, bytes: statSync(msiPath).size, sha256: sha256(msiPath) },
    ],
  }))
  writeChecksums(root)

  const valid = run(root)
  assert.equal(valid.status, 0, valid.stderr || valid.stdout)
  assert.match(valid.stdout, /"publishable": true/)
  assert.match(valid.stdout, /"macos"/)
  assert.match(valid.stdout, /"windows"/)

  const incomplete = `${root}-incomplete`
  mkdirSync(incomplete)
  cpSync(mac, join(incomplete, "mac"), { recursive: true })
  writeChecksums(incomplete)
  const missingWindows = run(incomplete)
  assert.notEqual(missingWindows.status, 0)
  assert.match(missingWindows.stderr, /requires genuine Windows NSIS and MSI/)

  const corrupt = `${root}-corrupt`
  cpSync(root, corrupt, { recursive: true })
  writeChecksums(corrupt)
  writeFileSync(join(corrupt, "windows-x64", basename(exePath)), Buffer.from("corrupt"))
  const badChecksum = run(corrupt)
  assert.notEqual(badChecksum.status, 0)
  assert.match(badChecksum.stderr, /Checksum mismatch/)

  mkdirSync(join(crlfAlignmentRoot, "src-tauri"), { recursive: true })
  mkdirSync(join(crlfAlignmentRoot, "public", "downloads"), { recursive: true })
  writeFileSync(join(crlfAlignmentRoot, "package.json"), JSON.stringify({ version }))
  writeFileSync(join(crlfAlignmentRoot, "package-lock.json"), JSON.stringify({
    packages: {
      "": { version },
      "node_modules/@tauri-apps/cli": { version: "2.11.3" },
      "node_modules/@tauri-apps/api": { version: "2.11.1" },
    },
  }))
  writeFileSync(join(crlfAlignmentRoot, "src-tauri", "tauri.conf.json"), JSON.stringify({ version }))
  writeFileSync(join(crlfAlignmentRoot, "src-tauri", "Cargo.toml"), `[package]\r\nversion = "${version}"\r\n`)
  writeFileSync(
    join(crlfAlignmentRoot, "src-tauri", "Cargo.lock"),
    [
      "[[package]]", `name = "bezgrow-erp"`, `version = "${version}"`, "",
      "[[package]]", `name = "tauri"`, `version = "2.11.3"`, "",
      "[[package]]", `name = "tauri-plugin-updater"`, `version = "2.10.1"`, "",
    ].join("\r\n")
  )
  writeFileSync(join(crlfAlignmentRoot, "RELEASE_NOTES.md"), `# Bezgrow ${version}\r\n`)
  writeFileSync(join(crlfAlignmentRoot, "public", "downloads", "desktop-release.json"), JSON.stringify({
    version: "0.1.15",
    publicationStatus: "published",
  }))
  const crlfAlignment = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts", "verify-release-version-alignment.mjs")],
    { cwd: crlfAlignmentRoot, encoding: "utf8" }
  )
  assert.equal(crlfAlignment.status, 0, crlfAlignment.stderr || crlfAlignment.stdout)

  console.log("release-verifier-ok complete-cohort=accepted missing-windows=rejected bad-checksum=rejected source-alignment=verified crlf=verified")
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(`${root}-incomplete`, { recursive: true, force: true })
  rmSync(`${root}-corrupt`, { recursive: true, force: true })
  rmSync(crlfAlignmentRoot, { recursive: true, force: true })
}
