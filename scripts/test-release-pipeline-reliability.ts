import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  commonPublishedVersion,
  compareReleaseVersions,
  selectLatestPublishedInstaller,
  type PublishedReleaseCandidate,
} from "../lib/releases/policy"

type Candidate = PublishedReleaseCandidate & { platform: "macos" | "windows"; url: string }

function candidate(
  version: string,
  platform: Candidate["platform"],
  publicationStatus: string,
  available = true,
  suffix = ""
): Candidate {
  return {
    version,
    platform,
    publicationStatus,
    available,
    productionRecommended: false,
    checksumVerified: available,
    metadataValid: available,
    releaseChannel: "internal",
    url: `https://github.com/Pushker-Gera/Bezgrow/releases/download/v${version}/Bezgrow-${version}-${platform}${suffix}`,
  }
}

assert.ok(compareReleaseVersions("0.2.0", "0.1.15") < 0)

const oldMac = candidate("0.1.15", "macos", "published")
const oldWindows = candidate("0.1.15", "windows", "published")
const draftMac = candidate("0.2.0", "macos", "draft")
const draftWindows = candidate("0.2.0", "windows", "building")

assert.equal(
  selectLatestPublishedInstaller([oldMac, draftMac]),
  oldMac,
  "Source/draft 0.2.0 must not hide the published 0.1.15 Mac release."
)
assert.equal(
  selectLatestPublishedInstaller([oldWindows, draftWindows]),
  oldWindows,
  "Source/draft 0.2.0 must not hide the published 0.1.15 Windows release."
)
assert.equal(selectLatestPublishedInstaller([draftMac]), null, "Draft releases must never be public.")

const failedMac = candidate("0.2.0", "macos", "failed", false)
assert.equal(
  selectLatestPublishedInstaller([oldMac, failedMac]),
  oldMac,
  "A failed release must leave the previous installer downloadable."
)

const invalidPublishedMac = candidate("0.2.0", "macos", "published", false)
assert.equal(
  selectLatestPublishedInstaller([oldMac, invalidPublishedMac]),
  oldMac,
  "A corrupt newer record must not remove a previous valid published installer."
)

const readyMac = candidate("0.2.0", "macos", "ready")
const publishedMac = candidate("0.2.0", "macos", "published")
const publishedWindows = candidate("0.2.0", "windows", "published")
assert.equal(selectLatestPublishedInstaller([oldMac, readyMac]), oldMac, "READY is not public until promotion.")
assert.equal(selectLatestPublishedInstaller([oldMac, publishedMac]), publishedMac)
assert.equal(selectLatestPublishedInstaller([oldWindows, publishedWindows]), publishedWindows)
assert.equal(commonPublishedVersion([publishedMac, publishedWindows]), "0.2.0")
assert.equal(commonPublishedVersion([publishedMac, oldWindows]), null, "Staged platform releases must retain their exact per-platform versions.")
assert.match(publishedMac.url, /0\.2\.0/, "The download URL must carry the exact published version.")

const publicSource = readFileSync("lib/releases/public.ts", "utf8")
const updaterRoute = readFileSync("app/api/desktop-updater/[target]/[arch]/[currentVersion]/route.ts", "utf8")
const downloadPage = readFileSync("app/download/page.tsx", "utf8")
const workflow = readFileSync(".github/workflows/desktop-release.yml", "utf8")
const publication = readFileSync("scripts/publish-release-metadata.mjs", "utf8")

assert.doesNotMatch(publicSource, /releaseCandidateVersions|newest intended version/, "Public selection must not be driven by source-version candidates.")
assert.match(publicSource, /source[\s\S]*version bump must never hide/i)
assert.match(publicSource, /filter\(isExplicitlyPublished\)/)
assert.match(downloadPage, /macInstaller\.version[\s\S]*windowsInstaller\.version/, "The page must show actual platform versions.")
assert.match(updaterRoute, /\.eq\("release_status", "published"\)/)
assert.match(updaterRoute, /artifact\?\.validation_status === "valid"/)
assert.match(workflow, /needs\.mac\.result == 'success'[\s\S]*needs\.windows\.result == 'success'/)
assert.match(publication, /publicationMode === "cross-platform"[\s\S]*artifactPlatforms\.has\("macos"\)[\s\S]*artifactPlatforms\.has\("windows"\)/)

console.log("release-pipeline-reliability-ok source-public-separated=true fallback=0.1.15 drafts-hidden=true atomic-cohort=true updater-published-only=true")
