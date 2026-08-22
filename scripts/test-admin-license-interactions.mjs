import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitForServer(url, child) {
  const deadline = Date.now() + 60_000
  let lastError = ""
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Licence interaction fixture exited with ${child.exitCode}.`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await wait(200)
  }
  throw new Error(`Licence interaction fixture did not become ready: ${lastError}`)
}

const port = await availablePort()
const origin = `http://127.0.0.1:${port}`
const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: process.cwd(),
    env: { ...process.env, BEZGROW_RELEASE_TEST: "1", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
let serverOutput = ""
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString() })
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString() })

let browser
try {
  const url = `${origin}/release-tests/license-actions`
  await waitForServer(url, server)
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  const dialogs = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.type())
    void dialog.dismiss()
  })
  await page.goto(url, { waitUntil: "networkidle" })

  const activeRow = page.locator('[data-license-actions="LIC-INTERACTION-FIXTURE-0001"]')
  const suspendedRow = page.locator('[data-license-actions="LIC-INTERACTION-SUSPENDED-0002"]')
  await activeRow.waitFor()

  for (const action of ["copy", "download", "history"]) {
    await activeRow.locator(`[data-license-action="${action}"]`).click()
    await assert.doesNotReject(async () => {
      await page.locator("[data-last-license-control]").filter({ hasText: action }).waitFor()
    })
  }

  const submissions = [
    ["renew", async () => {}],
    ["extend", async () => { await page.getByLabel("Days to add").fill("45") }],
    ["change_grace", async () => { await page.getByLabel(/Grace period in days/).fill("14") }],
    ["update_features", async () => { await page.getByLabel("Plan name").fill("Growth Offline ERP") }],
    ["replace_device", async () => {
      await page.getByLabel("Target Device ID", { exact: true }).fill("BZG-TARGET-DEVICE-0001")
      await page.getByLabel("Re-enter target Device ID").fill("BZG-TARGET-DEVICE-0001")
      await page.getByLabel("Reason").fill("Fixture replacement")
    }],
    ["transfer", async () => {
      await page.getByLabel("Target Device ID", { exact: true }).fill("BZG-TARGET-DEVICE-0002")
      await page.getByLabel("Re-enter target Device ID").fill("BZG-TARGET-DEVICE-0002")
      await page.getByLabel("Reason").fill("Fixture transfer")
    }],
    ["suspend", async () => { await page.getByLabel(/Type SUSPEND/).fill("SUSPEND") }],
    ["revoke", async () => {
      await page.getByLabel("Reason (required)").fill("Fixture revocation")
      await page.getByLabel(/Type REVOKE/).fill("REVOKE")
    }],
  ]

  for (const [action, prepare] of submissions) {
    const button = activeRow.locator(`[data-license-action="${action}"]`)
    const target = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return { width: rect.width, height: rect.height, hit: hit === element || element.contains(hit) }
    })
    assert.ok(target.width > 20 && target.height > 20, `${action} has an unusable pointer target.`)
    assert.equal(target.hit, true, `${action} is covered by another DOM layer.`)
    await button.click()
    await page.locator(`[data-license-action-form="${action}"]`).waitFor()
    await prepare()
    await page.locator(`[data-license-action-form="${action}"] button[type="submit"]`).click()
    await page.locator("[data-last-license-control]").filter({ hasText: action }).waitFor()
    const mutation = JSON.parse(await page.locator("[data-last-license-mutation]").textContent())
    assert.equal(mutation.action, action)
    assert.match(mutation.idempotency_key, /^[0-9a-f-]{20,}$/i)
  }

  await suspendedRow.locator('[data-license-action="reactivate"]').click()
  await page.getByLabel(/Type REACTIVATE/).fill("REACTIVATE")
  await page.locator('[data-license-action-form="reactivate"] button[type="submit"]').click()
  await page.locator("[data-last-license-control]").filter({ hasText: "reactivate" }).waitFor()

  assert.deepEqual(dialogs, [], "Licence actions invoked a blocking browser dialog.")
  const dragContract = await activeRow.locator('[data-license-action="renew"]').evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region"))
  assert.ok(dragContract === "no-drag" || dragContract === "", `Unexpected app-region contract: ${dragContract}`)
  console.log("admin-license-interactions-ok controls=12 mutations=9 blocking-dialogs=0 covered-targets=0")
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverOutput.slice(-8_000)}`)
} finally {
  await browser?.close().catch(() => undefined)
  server.kill("SIGTERM")
}
