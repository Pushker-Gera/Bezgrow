import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import packageJson from "../package.json" with { type: "json" }

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const nodeBinary = join(root, "desktop-runtime", "node", process.platform === "win32" ? "node.exe" : "node")
const serverEntry = join(root, "desktop-runtime", "next-server", "server.js")
const buildIdentityPath = join(root, "desktop-runtime", "next-server", "public", "desktop-build.json")
const configuredStartupTimeout = Number(process.env.BEZGROW_DESKTOP_STARTUP_TIMEOUT_MS || 15_000)
const startupTimeoutMs = Number.isFinite(configuredStartupTimeout) && configuredStartupTimeout >= 3_000
  ? configuredStartupTimeout
  : 15_000

if (!existsSync(nodeBinary) || !existsSync(serverEntry) || !existsSync(buildIdentityPath)) {
  throw new Error("Run npm run desktop:prepare before measuring desktop startup.")
}

const buildIdentity = JSON.parse(readFileSync(buildIdentityPath, "utf8"))
if (
  buildIdentity.applicationVersion !== packageJson.version ||
  !/^[a-f0-9]{40}$/i.test(buildIdentity.gitCommit || "") ||
  Number.isNaN(Date.parse(buildIdentity.builtAt || "")) ||
  buildIdentity.sourceTreeDirty === true
) {
  throw new Error("The prepared desktop runtime does not contain a clean, version-matched build identity.")
}

const port = await new Promise((resolve, reject) => {
  const reservation = createServer()
  reservation.once("error", reject)
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address()
    const reservedPort = typeof address === "object" && address ? address.port : 0
    reservation.close((error) => error ? reject(error) : resolve(reservedPort))
  })
})

const startedAt = performance.now()
const runtimeToken = "desktop-startup-test-token-0123456789abcdef0123456789abcdef"
const child = spawn(nodeBinary, [serverEntry], {
  cwd: dirname(serverEntry),
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
    BEZGROW_DESKTOP_BUILD: "1",
    BEZGROW_RUNTIME_TOKEN: runtimeToken,
    BEZGROW_RUNTIME_VERSION: packageJson.version,
    BEZGROW_RUNTIME_BUILD_COMMIT: buildIdentity.gitCommit,
    BEZGROW_RUNTIME_BUILD_TIMESTAMP: buildIdentity.builtAt,
    BEZGROW_RUNTIME_SHELL_PID: String(process.pid),
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
})

let stderr = ""
let stdout = ""
let childExit = null
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4000)
})
child.stdout.on("data", (chunk) => {
  stdout = `${stdout}${chunk}`.slice(-4000)
})
child.once("exit", (code, signal) => {
  childExit = { code, signal }
})

try {
  let response
  let healthy = false
  let lastHealth = null
  let responseFailure = ""
  while (performance.now() - startedAt < startupTimeoutMs && !childExit) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/desktop-health`, {
        redirect: "manual",
        headers: { "X-Bezgrow-Runtime-Token": runtimeToken },
      })
      if (response.status === 200) {
        const health = await response.json()
        lastHealth = health
        if (
          health.runtime === "bezgrow-embedded" &&
          health.appVersion === packageJson.version &&
          health.shellPid === process.pid &&
          health.serverPid === child.pid
        ) {
          healthy = true
          break
        }
      } else if (response.status >= 500) {
        responseFailure = `${response.status} ${await response.text()}`
        break
      }
    } catch {
      // The bundled server has not bound its loopback socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const startupMs = performance.now() - startedAt
  if (!healthy) {
    throw new Error(
      `Desktop server did not become ready within ${startupTimeoutMs}ms.` +
      `\nhealth=${responseFailure || JSON.stringify(lastHealth) || response?.status || "unreachable"}` +
      `\nexit=${JSON.stringify(childExit)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    )
  }
  if (startupMs >= startupTimeoutMs) {
    throw new Error(`Desktop server startup exceeded ${startupTimeoutMs}ms: ${startupMs.toFixed(1)}ms`)
  }
  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/desktop-health`)
  if (unauthenticated.status !== 404) {
    throw new Error(`Desktop health route accepted an unauthenticated request with ${unauthenticated.status}.`)
  }
  console.log(`desktop-startup-ok ${startupMs.toFixed(1)}ms`)
} finally {
  let forcedShutdown = false
  if (child.exitCode === null && child.signalCode === null) {
    child.kill()
    forcedShutdown = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL")
        resolve(true)
      }, 5000)
      child.once("exit", () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })
  }
  if (forcedShutdown) {
    throw new Error("Desktop server did not shut down within 5000ms after termination.")
  }
}
