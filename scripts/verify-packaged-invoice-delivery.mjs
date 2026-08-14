import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join } from "node:path"

function readArgument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`Missing required ${name} argument.`)
  }
  return process.argv[index + 1]
}

function javascriptFilesUnder(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && extname(entry.name) === ".js") files.push(path)
    }
  }
  return files
}

const serverRoot = readArgument("--server-root")
const executable = readArgument("--executable")
if (!existsSync(serverRoot) || !statSync(serverRoot).isDirectory()) {
  throw new Error(`Packaged Next.js server was not found at ${serverRoot}.`)
}
if (!existsSync(executable) || !statSync(executable).isFile()) {
  throw new Error(`Packaged desktop executable was not found at ${executable}.`)
}

const packagedJavaScript = javascriptFilesUnder(serverRoot).map((filename) => readFileSync(filename, "utf8"))
const includes = (marker) => packagedJavaScript.some((source) => source.includes(marker))

for (const forbidden of [
  "Your invoice PDF has been prepared separately. Please attach it before sending.",
  "prepared separately",
  "attach it before sending",
  "attach PDF",
  "manual attachment",
]) {
  if (includes(forbidden)) {
    throw new Error(`Packaged app still contains forbidden invoice-sharing copy: ${forbidden}`)
  }
}
if (includes("Create secure share link")) {
  throw new Error("Packaged app still contains the obsolete secure-share modal.")
}
if (!includes("Please find your invoice summary below.")) {
  throw new Error("Packaged app is missing the professional WhatsApp invoice message.")
}
if (!includes("Platform Admin Login") || !includes("/api/platform-admin/device/authorize")) {
  throw new Error("Packaged app is missing the device-authorized Platform Admin launcher.")
}
if (!includes("canonical-pdf-preview")) {
  throw new Error("Packaged app is missing the canonical PDF preview implementation.")
}
for (const required of [
  "The saved business logo could not be embedded in the invoice PDF.",
  "Exact amount:",
  "data-money-value",
  "About / Version",
  "Copy Build ID",
]) {
  if (!includes(required)) {
    throw new Error(`Packaged app is missing release-critical invoice/KPI/build-identity behavior: ${required}`)
  }
}
const executableBytes = readFileSync(executable)
if (!executableBytes.includes(Buffer.from("desktop_open_pdf_for_print"))) {
  throw new Error("Packaged app is missing the validated native PDF print command.")
}
for (const command of ["open_platform_admin", "desktop_platform_admin_proof"]) {
  if (!executableBytes.includes(Buffer.from(command))) {
    throw new Error(`Packaged app is missing the native ${command} command.`)
  }
}

console.log(`packaged-invoice-delivery-ok jsFiles=${packagedJavaScript.length}`)
