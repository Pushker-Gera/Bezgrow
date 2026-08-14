import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { chromium } from "@playwright/test"

const values = [
  999,
  9_999,
  99_999,
  9_99_999,
  1_23_45_678,
  9_99_99_99_999,
  1_00_00_00_00_00_000,
  Number.MAX_SAFE_INTEGER,
]
const desktopWidths = [1100, 1280, 1360, 1440, 1920]

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

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 60_000
  let lastError = ""
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Money-card fixture server exited with ${child.exitCode}.`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await wait(200)
  }
  throw new Error(`Money-card fixture did not become ready: ${lastError}`)
}

const port = await availablePort()
const origin = `http://127.0.0.1:${port}`
const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BEZGROW_RELEASE_TEST: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
)
let serverOutput = ""
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString() })
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString() })

let browser
try {
  await waitForServer(`${origin}/release-tests/money-cards`, server)
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()

  for (const width of desktopWidths) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${origin}/release-tests/money-cards`, { waitUntil: "networkidle" })
    await page.locator("[data-money-value]").first().waitFor()

    const result = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-money-card]")]
      const money = [...document.querySelectorAll("[data-money-value]")]
      const cardRects = cards.map((card) => card.getBoundingClientRect())
      const moneyRects = money.map((value) => value.getBoundingClientRect())
      const overlaps = []
      for (let leftIndex = 0; leftIndex < cardRects.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < cardRects.length; rightIndex += 1) {
          const left = cardRects[leftIndex]
          const right = cardRects[rightIndex]
          const overlap = left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
          if (overlap) overlaps.push([leftIndex, rightIndex])
        }
      }
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        overlaps,
        cards: cards.map((card, index) => ({
          overflow: card.scrollWidth - card.clientWidth,
          moneyOutside:
            moneyRects[index].left < cardRects[index].left - 0.5 ||
            moneyRects[index].right > cardRects[index].right + 0.5,
        })),
        money: money.map((value) => ({
          display: value.textContent?.replace(/Exact amount:.*$/, "").trim() || "",
          exact: value.getAttribute("title"),
          accessible: value.getAttribute("aria-label"),
          mode: value.getAttribute("data-display-mode"),
          overflow: value.scrollWidth - value.clientWidth,
        })),
      }
    })

    assert.ok(result.documentOverflow <= 0, `${width}px viewport overflowed by ${result.documentOverflow}px.`)
    assert.deepEqual(result.overlaps, [], `${width}px viewport has overlapping KPI cards.`)
    assert.equal(result.cards.length, values.length)
    result.cards.forEach((card, index) => {
      assert.ok(card.overflow <= 0, `${width}px card ${index} overflowed by ${card.overflow}px.`)
      assert.equal(card.moneyOutside, false, `${width}px card ${index} allowed its money value outside the card.`)
    })
    result.money.forEach((money, index) => {
      assert.ok(money.exact?.startsWith("₹"), `${width}px value ${index} has no exact Indian-currency tooltip.`)
      assert.equal(money.accessible, money.exact, `${width}px value ${index} lost its exact accessible value.`)
      assert.ok(money.overflow <= 0, `${width}px value ${index} clipped its rendered compact representation.`)
      if (index >= 3) {
        assert.equal(money.mode, "compact", `${width}px value ${index} should use a compact display.`)
        assert.match(money.display, /(?:L|Cr)$/, `${width}px value ${index} has no lakh/crore suffix.`)
      } else {
        assert.equal(money.mode, "exact", `${width}px value ${index} should remain exact.`)
      }
    })
  }

  console.log(`money-card-layout-ok widths=${desktopWidths.join(",")} values=${values.length} exact-accessible=true overlaps=0`)
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverOutput.slice(-8_000)}`)
} finally {
  await browser?.close().catch(() => undefined)
  server.kill("SIGTERM")
}
