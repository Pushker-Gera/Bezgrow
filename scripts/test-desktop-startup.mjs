import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import packageJson from "../package.json" with { type: "json" }

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const nodeBinary = join(root, "desktop-runtime", "node", process.platform === "win32" ? "node.exe" : "node")
const serverEntry = join(root, "desktop-runtime", "next-server", "server.js")

if (!existsSync(nodeBinary) || !existsSync(serverEntry)) {
  throw new Error("Run npm run desktop:prepare before measuring desktop startup.")
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
    BEZGROW_RUNTIME_SHELL_PID: String(process.pid),
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
})

let stderr = ""
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4000)
})

try {
  let response
  while (performance.now() - startedAt < 3000) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/desktop-health`, {
        redirect: "manual",
        headers: { "X-Bezgrow-Runtime-Token": runtimeToken },
      })
      if (response.status === 200) {
        const health = await response.json()
        if (
          health.runtime === "bezgrow-embedded" &&
          health.appVersion === packageJson.version &&
          health.shellPid === process.pid &&
          health.serverPid === child.pid
        ) break
      }
    } catch {
      // The bundled server has not bound its loopback socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  const startupMs = performance.now() - startedAt
  if (!response || response.status !== 200) {
    throw new Error(`Desktop server did not become ready within 3000ms.\n${stderr}`)
  }
  if (startupMs >= 3000) {
    throw new Error(`Desktop server startup exceeded 3000ms: ${startupMs.toFixed(1)}ms`)
  }
  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/desktop-health`)
  if (unauthenticated.status !== 404) {
    throw new Error(`Desktop health route accepted an unauthenticated request with ${unauthenticated.status}.`)
  }
  console.log(`desktop-startup-ok ${startupMs.toFixed(1)}ms`)
} finally {
  child.kill()
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 2000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}
