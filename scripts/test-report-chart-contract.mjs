import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../app/dashboard/charts/page.tsx", import.meta.url), "utf8")

assert.match(source, /function PieLegendSummary/, "Pie and doughnut charts need visible legends")
assert.match(source, /\{item\.value\} · \{percentage\}%/, "Pie legends must show count and percentage")
assert.match(source, /label=\{pieLabel\}/, "Pie segments need visible category and percentage labels")
assert.match(source, /labelStyle: \{ color: "#ffffff"/, "Dark tooltips need a high-contrast title")
assert.match(source, /itemStyle: \{ color: "#f8fafc"/, "Dark tooltips need high-contrast values")
assert.match(source, /border: "1px solid #64748b"/, "Dark tooltips need a visible border")
assert.match(source, /allowEscapeViewBox: \{ x: false, y: false \}/, "Tooltips must remain inside the chart viewport")
assert.match(source, /function ChartSummary/, "Non-pie charts need an accessible text/table summary")
for (const chart of ["weekly-revenue", "stock-health", "category-value", "product-margin", "expiry-risk"]) {
  assert.match(source, new RegExp(`data-report-chart="${chart}"`), `${chart} must expose a verified report chart root`)
}
assert.match(source, /function ChartEmpty/, "Every chart must provide an empty state")
assert.match(source, /Healthy: "#34d399"[\s\S]*"Low Stock": "#fbbf24"[\s\S]*Expired: "#fb7185"/, "Status colours must stay consistent across report charts")

console.log("report-chart-contract-ok charts=5 legends=true summaries=true dark_tooltips=true")
