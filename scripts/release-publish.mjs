import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1] || fallback
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: process.cwd(), encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed.`)
  return result.stdout.trim()
}

const positionalVersion = process.argv.slice(2).find((value) => /^\d+\.\d+\.\d+$/.test(value)) || ""
const version = arg("--version", positionalVersion)
const channel = arg("--channel").toLowerCase()
const dryRun = /^(1|true|yes)$/i.test(arg("--dry-run", "false"))
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version

if (version !== packageVersion) throw new Error(`Requested release ${version || "(missing)"} does not match source ${packageVersion}.`)
if (!["internal", "stable"].includes(channel)) {
  throw new Error("Explicit --channel internal or --channel stable is required.")
}
run(process.execPath, ["scripts/verify-release-version-alignment.mjs"])

const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim()
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const originMain = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim()
const trackedChanges = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()
if (branch !== "main") throw new Error(`Release publication must be dispatched from main, not ${branch || "detached HEAD"}.`)
if (trackedChanges) throw new Error("Release publication requires a clean tracked source tree.")
if (head !== originMain) throw new Error(`Local main ${head} does not match origin/main ${originMain}.`)

const signing = channel === "stable" ? "required" : "auto"
const commandArgs = [
  "workflow", "run", "desktop-release.yml",
  "--ref", "main",
  "-f", `version=${version}`,
  "-f", "platform=all",
  "-f", `release_channel=${channel}`,
  "-f", `signing=${signing}`,
  "-f", "draft_release=false",
  "-f", "publish=true",
]

if (!dryRun) run("gh", commandArgs)
console.log(JSON.stringify({
  dispatched: !dryRun,
  dryRun,
  workflow: "desktop-release.yml",
  version,
  channel,
  sourceCommit: head,
  platforms: ["macos", "windows"],
  publicationPolicy: "cross-platform-atomic",
}, null, 2))
