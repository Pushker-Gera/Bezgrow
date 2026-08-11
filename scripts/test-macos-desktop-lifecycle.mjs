import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "darwin") throw new Error("The packaged macOS lifecycle test must run on macOS.")

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const valueAfter = (name, fallback = "") => {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] || fallback : fallback
}
const appPath = resolve(valueAfter("app", join(root, "src-tauri", "target", "release", "bundle", "macos", "Bezgrow.app")))
const binaryPath = join(appPath, "Contents", "MacOS", "Bezgrow")
const cycles = Number(valueAfter("cycles", "20"))
const expectedStalePid = Number(valueAfter("expect-stale-pid", "0"))
const dataRoot = join(homedir(), "Library", "Application Support", "com.bezgrow.erp")
const runtimeStatePath = join(dataRoot, "Runtime", "runtime.json")
const databasePath = join(dataRoot, "bezgrow-offline.db")
const deviceIdPath = join(dataRoot, "Installation", "device-id")
const startupLogPath = join(dataRoot, "Logs", "bezgrow-startup.log")
const preferredPort = 43124

if (!existsSync(binaryPath)) throw new Error(`Packaged Bezgrow binary is missing: ${binaryPath}`)
if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 100) throw new Error("--cycles must be between 1 and 100.")

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
const processExists = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitUntil = async (condition, timeoutMs, failure) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await condition()) return
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }
  throw new Error(`${failure}${lastError ? ` (${lastError.message})` : ""}`)
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const readRuntime = () => JSON.parse(readFileSync(runtimeStatePath, "utf8"))
const listenerPids = (port) => {
  const result = spawnSync("/usr/sbin/lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
  if (result.status !== 0 && result.status !== 1) throw new Error(`lsof failed for port ${port}.`)
  return result.stdout.split(/\s+/).filter(Boolean).map(Number)
}
const portIsFree = (port) => new Promise((resolvePort) => {
  const server = createServer()
  server.once("error", () => resolvePort(false))
  server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)))
})
const runtimeHealth = async (runtime) => {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/desktop-health`, {
    headers: { "X-Bezgrow-Runtime-Token": runtime.token },
    signal: AbortSignal.timeout(1000),
  })
  if (response.status !== 200) return false
  const health = await response.json()
  return health.runtime === "bezgrow-embedded" &&
    health.appVersion === runtime.appVersion &&
    health.shellPid === runtime.shellPid &&
    health.serverPid === runtime.serverPid
}

function sqliteSnapshot() {
  if (!existsSync(databasePath)) return { exists: false, integrity: "missing", counts: {} }
  const tablesResult = spawnSync("/usr/bin/sqlite3", ["-json", databasePath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"], { encoding: "utf8" })
  if (tablesResult.status !== 0) throw new Error("Unable to inspect the authoritative SQLite schema.")
  const tables = new Set(JSON.parse(tablesResult.stdout || "[]").map((row) => row.name))
  const counts = {}
  for (const table of ["products", "customers", "sales_invoices", "orders", "license_state"]) {
    if (!tables.has(table)) continue
    const result = spawnSync("/usr/bin/sqlite3", [databasePath, `SELECT COUNT(*) FROM ${table}`], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`Unable to count SQLite table ${table}.`)
    counts[table] = Number(result.stdout.trim())
  }
  const integrity = spawnSync("/usr/bin/sqlite3", [databasePath, "PRAGMA quick_check"], { encoding: "utf8" })
  if (integrity.status !== 0) throw new Error("Unable to run SQLite quick_check.")
  return { exists: true, integrity: integrity.stdout.trim().toLowerCase(), counts }
}

function persistenceSnapshot() {
  const deviceId = existsSync(deviceIdPath) ? sha256(readFileSync(deviceIdPath)) : null
  const license = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "com.bezgrow.erp", "-a", "bezgrow-offline-license-key", "-w"], { encoding: "utf8" })
  return {
    deviceId,
    license: license.status === 0 ? sha256(license.stdout.trim()) : null,
    sqlite: sqliteSnapshot(),
  }
}

function assertPersistence(before, after) {
  if (before.deviceId !== after.deviceId) throw new Error("Device ID changed during lifecycle testing.")
  if (before.license !== after.license) throw new Error("Local license changed during lifecycle testing.")
  if (before.sqlite.exists !== after.sqlite.exists) throw new Error("SQLite database presence changed during lifecycle testing.")
  if (after.sqlite.exists && after.sqlite.integrity !== "ok") throw new Error(`SQLite integrity is ${after.sqlite.integrity}.`)
  for (const [table, count] of Object.entries(before.sqlite.counts)) {
    if (after.sqlite.counts[table] !== count) throw new Error(`SQLite ${table} count changed from ${count} to ${after.sqlite.counts[table]}.`)
  }
}

async function launch() {
  const child = spawn(binaryPath, [], { cwd: dirname(binaryPath), stdio: "ignore" })
  await waitUntil(() => {
    if (!existsSync(runtimeStatePath)) return false
    const runtime = readRuntime()
    return runtime.shellPid === child.pid && processExists(runtime.serverPid)
  }, 20_000, `Bezgrow shell ${child.pid} did not establish runtime ownership.`)
  const runtime = readRuntime()
  await waitUntil(() => runtimeHealth(runtime), 10_000, `Bezgrow runtime ${runtime.serverPid} did not pass authenticated health.`)
  const owners = listenerPids(runtime.port)
  if (owners.length !== 1 || owners[0] !== runtime.serverPid) {
    throw new Error(`Runtime port ${runtime.port} owners ${owners.join(",")} did not match server PID ${runtime.serverPid}.`)
  }
  const unauthenticated = await fetch(`http://127.0.0.1:${runtime.port}/api/desktop-health`)
  if (unauthenticated.status !== 404) throw new Error("Packaged health endpoint accepted an unauthenticated request.")
  return { child, runtime }
}

async function quitNormally(active, cause = "Apple-event quit") {
  const result = spawnSync("/usr/bin/osascript", ["-e", 'tell application id "com.bezgrow.erp" to quit'], { encoding: "utf8", timeout: 10_000 })
  if (result.status !== 0) throw new Error(`${cause} failed: ${result.stderr.trim()}`)
  await verifyStopped(active, cause)
}

async function closeMainWindow(active) {
  await waitUntil(() => {
    const probe = spawnSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to tell process "Bezgrow" to return (count of windows) > 0'], { encoding: "utf8", timeout: 2_000 })
    return probe.status === 0 && probe.stdout.trim() === "true"
  }, 10_000, "Native Bezgrow main window was not exposed to macOS Accessibility.")
  const result = spawnSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to tell process "Bezgrow" to click button 1 of front window'], { encoding: "utf8", timeout: 10_000 })
  if (result.status !== 0) throw new Error(`Native main-window close failed: ${result.stderr.trim()}`)
  await verifyStopped(active, "native main-window close")
}

async function verifyStopped(active, cause) {
  await waitUntil(() => !processExists(active.child.pid), 10_000, `${cause} did not stop shell ${active.child.pid}.`)
  await waitUntil(() => !processExists(active.runtime.serverPid), 5_000, `${cause} left server ${active.runtime.serverPid}.`)
  await waitUntil(() => !existsSync(runtimeStatePath), 5_000, `${cause} left runtime metadata.`)
  await waitUntil(() => portIsFree(active.runtime.port), 5_000, `${cause} did not release port ${active.runtime.port}.`)
}

async function testSecondLaunch(active) {
  const duplicate = spawn(binaryPath, [], { cwd: dirname(binaryPath), stdio: "ignore" })
  await waitUntil(() => !processExists(duplicate.pid), 5_000, `Second Bezgrow shell ${duplicate.pid} did not hand off to the first instance.`)
  const current = readRuntime()
  if (current.shellPid !== active.child.pid || current.serverPid !== active.runtime.serverPid) {
    throw new Error("Second launch replaced or duplicated the authoritative runtime.")
  }
  if (!processExists(active.child.pid) || !await runtimeHealth(current)) throw new Error("First Bezgrow instance was not healthy after the second launch.")
}

async function forceKillAndRecover() {
  const killed = await launch()
  killed.child.kill("SIGKILL")
  await waitUntil(() => !processExists(killed.child.pid), 5_000, "Force-killed shell remained alive.")
  await waitUntil(() => processExists(killed.runtime.serverPid), 3_000, "Force-kill fixture did not create the expected orphan server.")
  const recovered = await launch()
  if (recovered.runtime.serverPid === killed.runtime.serverPid || processExists(killed.runtime.serverPid)) {
    throw new Error("Next launch did not terminate and replace the verified orphan server.")
  }
  await quitNormally(recovered, "force-kill recovery quit")
}

async function unrelatedPortCollision() {
  if (!await portIsFree(preferredPort)) throw new Error(`Cannot create unrelated-port fixture because ${preferredPort} is occupied.`)
  const fixture = spawn(process.execPath, ["-e", `require('node:net').createServer(()=>{}).listen(${preferredPort},'127.0.0.1')`], { stdio: "ignore" })
  try {
    await waitUntil(async () => !await portIsFree(preferredPort), 5_000, "Unrelated-port fixture did not bind.")
    const active = await launch()
    if (active.runtime.port === preferredPort) throw new Error("Bezgrow navigated to the unrelated preferred-port listener.")
    if (!processExists(fixture.pid)) throw new Error("Bezgrow terminated the unrelated preferred-port owner.")
    await quitNormally(active, "authenticated fallback quit")
    if (!processExists(fixture.pid)) throw new Error("Unrelated preferred-port owner was not preserved through Bezgrow shutdown.")
  } finally {
    if (processExists(fixture.pid)) fixture.kill("SIGTERM")
    await waitUntil(() => !processExists(fixture.pid), 5_000, "Unrelated-port fixture did not stop.")
  }
  await waitUntil(() => portIsFree(preferredPort), 5_000, `Preferred port ${preferredPort} was not released after collision testing.`)
}

const before = persistenceSnapshot()
if (before.sqlite.exists && before.sqlite.integrity !== "ok") throw new Error(`SQLite was not healthy before testing: ${before.sqlite.integrity}`)

let first = await launch()
if (expectedStalePid) {
  if (processExists(expectedStalePid)) throw new Error(`Verified legacy stale process ${expectedStalePid} survived recovery.`)
  const log = existsSync(startupLogPath) ? readFileSync(startupLogPath, "utf8") : ""
  if (!log.includes(`Verified legacy Bezgrow runtime recovery completed. server_pid=${expectedStalePid}`)) {
    throw new Error(`Startup log did not prove legacy stale recovery for PID ${expectedStalePid}.`)
  }
}
await testSecondLaunch(first)
await closeMainWindow(first)

for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const active = await launch()
  await quitNormally(active, `launch/quit cycle ${cycle}`)
}

await forceKillAndRecover()
await unrelatedPortCollision()

const after = persistenceSnapshot()
assertPersistence(before, after)
if (!await portIsFree(preferredPort)) throw new Error(`Preferred port ${preferredPort} remained occupied after the lifecycle matrix.`)
if (existsSync(runtimeStatePath)) throw new Error("Transient runtime metadata remained after the lifecycle matrix.")

console.log(JSON.stringify({
  status: "macos-packaged-lifecycle-ok",
  cycles,
  singleInstance: "ok",
  nativeWindowClose: "full-exit-ok",
  forceKillRecovery: "ok",
  unrelatedPortFallback: "authenticated-and-owner-preserved",
  preferredPortReleased: true,
  orphanServers: 0,
  sqliteIntegrity: after.sqlite.integrity,
  sqliteCounts: after.sqlite.counts,
  deviceIdPreserved: before.deviceId === after.deviceId,
  licensePreserved: before.license === after.license,
}))
