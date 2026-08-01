import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { verifyUpdaterArtifact } from "../lib/releases/updater-signature"

const args = process.argv.slice(2)
const arg = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || "" : ""
}

const file = arg("--file")
const signatureFile = arg("--signature")
const sha256 = arg("--sha256")
const publicKey = process.env.BEZGROW_UPDATER_PUBLIC_KEY || ""
if (!file || !signatureFile || !sha256 || !publicKey) {
  throw new Error("Updater verification requires --file, --signature, --sha256, and BEZGROW_UPDATER_PUBLIC_KEY.")
}

async function run() {
  const result = await verifyUpdaterArtifact({
    url: "https://verification.invalid/updater",
    localFilePath: resolve(file),
    sha256,
    signature: (await readFile(resolve(signatureFile), "utf8")).trim(),
    publicKey,
  })
  console.log(JSON.stringify({ updater_signature: "valid", ...result }))
}

void run()
