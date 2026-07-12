#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { basename, resolve } from "node:path"

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
const cwd = process.cwd()
const failures = []
const warnings = []

function fail(message) {
  failures.push(message)
}

function warn(message) {
  warnings.push(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

function runGit(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)
}

function isIgnored(path) {
  try {
    execFileSync("git", ["check-ignore", "--quiet", path], { cwd: root })
    return true
  } catch {
    return false
  }
}

function envFile(path) {
  if (!existsSync(resolve(root, path))) return {}
  const values = {}
  for (const line of readFileSync(resolve(root, path), "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#") || !line.includes("=")) continue
    const index = line.indexOf("=")
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return values
}

function scanCommittedSecrets() {
  const sensitiveAssignments = [
    "BEZGROW_LICENSE_PRIVATE_KEY",
    "NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "BEZGROW_E2E_ADMIN_PASSWORD",
    "BEZGROW_E2E_USER_PASSWORD",
  ]
  const findings = []

  for (const file of trackedFiles()) {
    const path = resolve(root, file)
    let buffer
    try {
      buffer = readFileSync(path)
    } catch {
      continue
    }
    if (buffer.includes(0) || buffer.length > 2_000_000) continue
    const text = buffer.toString("utf8")

    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) findings.push(`${file}: private-key-block`)
    if (/gh[pousr]_[A-Za-z0-9_]{20,}/.test(text)) findings.push(`${file}: github-token`)
    if (/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/.test(text)) findings.push(`${file}: jwt-like-token`)

    for (const key of sensitiveAssignments) {
      const re = new RegExp(`^${key}=([^\\n#]+)`, "m")
      const match = re.exec(text)
      const value = match?.[1]?.trim()
      if (value) findings.push(`${file}: ${key}`)
    }
  }

  return findings
}

const packageJson = readJson(resolve(root, "package.json"))
const tauriConfig = readJson(resolve(root, "src-tauri/tauri.conf.json"))

if (resolve(cwd) !== root) fail(`Run from repository root: ${root}`)
if (basename(root) !== "saas-project" || tauriConfig.productName !== "Bezgrow") fail("Repository identity check failed.")

const branch = runGit(["branch", "--show-current"])
if (!branch.startsWith("final-production-hardening")) fail(`Unexpected branch: ${branch}`)

const unmerged = runGit(["diff", "--name-only", "--diff-filter=U"])
if (unmerged) fail("Repository has unresolved merge conflicts.")

for (const command of ["node", "npm", "git", "rustc", "cargo"]) {
  try {
    execFileSync(command, ["--version"], { encoding: "utf8" })
  } catch {
    fail(`Required tool missing: ${command}`)
  }
}

for (const path of [
  ".env",
  ".env.local",
  ".env.production",
  ".env.e2e",
  ".env.test.local",
  "credentials.json",
  "service-account-prod.json",
  "auth.json",
  "session.json",
]) {
  if (!isIgnored(path)) fail(`Secret-style file is not ignored: ${path}`)
}

const secretFindings = scanCommittedSecrets()
if (secretFindings.length) fail(`Potential committed secret assignments remain: ${secretFindings.join("; ")}`)

const e2eRequired = [
  "BEZGROW_E2E_ADMIN_EMAIL",
  "BEZGROW_E2E_ADMIN_PASSWORD",
  "BEZGROW_E2E_USER_EMAIL",
  "BEZGROW_E2E_USER_PASSWORD",
  "BEZGROW_E2E_BASE_URL",
]
const e2eLocal = envFile(".env.e2e")
const e2eMissing = e2eRequired.filter((key) => !e2eLocal[key])
if (e2eMissing.length) fail(`MANUAL ACTION REQUIRED: add missing E2E secret variables: ${e2eMissing.join(", ")}`)

const e2eExample = envFile(".env.e2e.example")
for (const key of e2eRequired) {
  if (e2eExample[key]) fail(`E2E example must not contain a real value for ${key}.`)
}
if (e2eExample.BEZGROW_E2E_TEST_BUSINESS_PREFIX !== "E2E-TEST-") fail("E2E test business prefix must be E2E-TEST-.")
if (e2eExample.BEZGROW_E2E_ALLOW_DESTRUCTIVE_TESTS !== "false") fail("Destructive E2E tests must be disabled by default.")

if (!existsSync(resolve(root, "lib/testing/e2e-safety.ts"))) fail("Shared E2E safety guard is missing.")
if (!existsSync(resolve(root, "qa-evidence/baseline/summary.json"))) fail("Baseline summary is missing.")

for (const key of ["BEZGROW_LICENSE_PRIVATE_KEY", "NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY"]) {
  if (!process.env[key]) fail(`MANUAL ACTION REQUIRED: configure or preserve existing license key env var: ${key}`)
}

for (const script of [
  "lint",
  "typecheck",
  "test",
  "test:e2e",
  "test:integration",
  "test:offline",
  "test:backup",
  "test:performance",
  "build",
  "desktop:prepare",
  "desktop:build",
  "preflight:final",
]) {
  if (!packageJson.scripts?.[script]) fail(`Package script missing: ${script}`)
}

for (const path of ["FINAL_BACKUP_AND_RECOVERY_NOTES.md", "FINAL_QA_CURRENT_BUGS.md", "CODEX_FINAL_RUN_GUARDRAILS.md"]) {
  if (!existsSync(resolve(root, path))) fail(`Required preparation document missing: ${path}`)
}

if (!existsSync(resolve(root, "package-lock.json"))) fail("package-lock.json is missing.")
if (!existsSync(resolve(root, "src-tauri/Cargo.lock"))) warn("Rust lockfile is missing.")

console.log(`Preflight branch: ${branch}`)
if (warnings.length) {
  console.log("Warnings:")
  for (const message of warnings) console.log(`- ${message}`)
}

if (failures.length) {
  console.error("Preflight failed:")
  for (const message of failures) console.error(`- ${message}`)
  process.exit(1)
}

console.log("Preflight passed.")
