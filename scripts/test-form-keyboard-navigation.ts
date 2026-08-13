import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { enterNavigationDecision, navigationAction } from "../lib/form-keyboard-navigation"

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

for (const type of ["text", "email", "tel", "number", "date", "search", "url"] as const) {
  assert.equal(
    enterNavigationDecision({ tagName: "INPUT", type }),
    "advance",
    `${type} inputs should advance on Enter`,
  )
}

assert.equal(
  enterNavigationDecision({ tagName: "INPUT", type: "text" }),
  "advance",
  "an optional empty text field must advance without value-gating",
)
assert.equal(enterNavigationDecision({ tagName: "SELECT" }), "advance", "selects should confirm and advance")
assert.equal(enterNavigationDecision({ tagName: "TEXTAREA" }), "native", "multiline fields must preserve newlines")
assert.equal(
  enterNavigationDecision({ tagName: "TEXTAREA", value: "", enterEmptyAdvance: true }),
  "advance",
  "an explicitly skippable empty optional textarea should advance",
)
assert.equal(
  enterNavigationDecision({ tagName: "TEXTAREA", value: "Existing description", enterEmptyAdvance: true }),
  "native",
  "a populated multiline field must preserve newline entry",
)
assert.equal(enterNavigationDecision({ tagName: "INPUT", type: "checkbox" }), "native", "checkboxes keep native keyboard behavior")
assert.equal(enterNavigationDecision({ tagName: "INPUT", type: "text", disabled: true }), "ignore", "disabled fields are ignored")
assert.equal(enterNavigationDecision({ tagName: "INPUT", type: "text", readOnly: true }), "ignore", "read-only fields are ignored")
assert.equal(navigationAction(0, 3), "advance", "a non-final field advances")
assert.equal(navigationAction(2, 3), "submit", "the last logical field invokes the primary action")
assert.equal(navigationAction(-1, 3), "ignore", "unscoped fields are ignored")

assert.match(read("app/dashboard/layout.tsx"), /<FormKeyboardNavigation\s*\/>/, "The reusable keyboard controller must mount once for the ERP workspace")
for (const [name, path] of [
  ["products", "app/dashboard/products/page.tsx"],
  ["customers", "app/dashboard/customers/page.tsx"],
  ["invoice creation", "app/dashboard/invoices/create/page.tsx"],
  ["stock", "app/dashboard/inventory/page.tsx"],
  ["business and print settings", "app/dashboard/settings/page.tsx"],
  ["invoice export", "components/invoices/InvoiceExportModal.tsx"],
] as const) {
  const source = read(path)
  assert.match(source, /data-enter-navigation="true"/, `${name} must declare a bounded Enter-navigation scope`)
  assert.match(source, /data-enter-primary(?:="true")?/, `${name} must declare its primary Enter action`)
}

console.log("form-keyboard-navigation-ok inputs=7 optional_empty=true empty_description_advance=true select=true textarea_newline=true last_field_submit=true scopes=6")
