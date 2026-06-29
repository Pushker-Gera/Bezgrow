import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import Link from "next/link"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import packageJson from "@/package.json"

const macInstallerPath = "/downloads/Bezgrow-mac.dmg"
const windowsInstallerPath = "/downloads/Bezgrow-windows.exe"
const desktopReleaseManifestPath = "/downloads/desktop-release.json"
const isDesktopBuild = process.env.BEZGROW_DESKTOP_BUILD === "1"

export const metadata: Metadata = {
  title: "Download Bezgrow Desktop App",
  description: "Download the Bezgrow desktop ERP app for Mac and Windows.",
  alternates: {
    canonical: "https://www.bezgrow.com/download",
  },
}

type InstallerInfo = {
  available: boolean
  href: string
  sizeLabel: string | null
  statusLabel: string
  blockedReason?: string
}

type ReleaseInstaller = {
  url?: string
  file?: string
  size?: number
  sha256?: string
  notarized?: boolean
  signed?: boolean
  version?: string
  generatedAt?: string
}

type DesktopReleaseManifest = {
  version?: string
  mac?: ReleaseInstaller | null
  windows?: ReleaseInstaller | null
}

function formatFileSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB"]
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

function readReleaseManifest(path: string) {
  const manifestPath = join(process.cwd(), "public", `${path.replace(/^\/+/, "")}.release.json`)

  if (!existsSync(manifestPath)) return null

  try {
    const manifest = JSON.parse(statSync(manifestPath).isFile() ? readFileSync(manifestPath, "utf8") : "{}") as {
      notarized?: boolean
    }
    return manifest.notarized ? manifest : null
  } catch {
    return null
  }
}

function readDesktopReleaseManifest() {
  const manifestPath = join(process.cwd(), "public", desktopReleaseManifestPath.replace(/^\/+/, ""))

  if (!existsSync(manifestPath)) return null

  try {
    return JSON.parse(statSync(manifestPath).isFile() ? readFileSync(manifestPath, "utf8") : "{}") as DesktopReleaseManifest
  } catch {
    return null
  }
}

function releaseHref(entry: ReleaseInstaller | null | undefined) {
  if (!entry) return ""
  if (entry.url) return entry.url
  if (!entry.file) return ""
  return entry.file.startsWith("/") ? entry.file : `/downloads/${entry.file}`
}

function getReleaseInstallerInfo(
  entry: ReleaseInstaller | null | undefined,
  options: { platform: "mac" | "windows"; manifestVersion?: string }
): InstallerInfo | null {
  const href = releaseHref(entry)
  if (!href) return null

  const sizeLabel = typeof entry?.size === "number" && Number.isFinite(entry.size) ? formatFileSize(entry.size) : null
  const version = entry?.version || options.manifestVersion || packageJson.version

  if (options.platform === "mac" && entry?.notarized !== true) {
    return {
      available: false,
      href,
      sizeLabel,
      statusLabel: "Notarization pending",
      blockedReason: "Mac installer is waiting for a notarized public release.",
    }
  }

  return {
    available: true,
    href,
    sizeLabel,
    statusLabel: `Version ${version}${sizeLabel ? ` | ${sizeLabel}` : ""}`,
  }
}

function getInstallerInfo(
  path: string,
  options: { requiresReleaseManifest?: boolean; releaseEntry?: ReleaseInstaller | null; manifestVersion?: string; platform?: "mac" | "windows" } = {}
): InstallerInfo {
  const releaseInfo = getReleaseInstallerInfo(options.releaseEntry, {
    platform: options.platform || "windows",
    manifestVersion: options.manifestVersion,
  })

  if (releaseInfo) return releaseInfo

  if (isDesktopBuild) {
    return { available: false, href: path, sizeLabel: null, statusLabel: "Coming soon" }
  }

  const fullPath = join(process.cwd(), "public", path.replace(/^\/+/, ""))

  if (!existsSync(fullPath)) {
    if (options.requiresReleaseManifest) {
      return {
        available: false,
        href: path,
        sizeLabel: null,
        statusLabel: "Notarization pending",
        blockedReason: "Mac installer is waiting for a notarized public release.",
      }
    }

    return { available: false, href: path, sizeLabel: null, statusLabel: "Coming soon" }
  }

  const sizeLabel = formatFileSize(statSync(fullPath).size)

  if (options.requiresReleaseManifest && !readReleaseManifest(path)) {
    return {
      available: false,
      href: path,
      sizeLabel,
      statusLabel: "Notarization pending",
      blockedReason: "Mac installer exists locally but is blocked until the notarized release manifest is present.",
    }
  }

  return {
    available: true,
    href: path,
    sizeLabel,
    statusLabel: `Version ${packageJson.version} | ${sizeLabel}`,
  }
}

function DownloadButton({
  href,
  available,
  children,
}: {
  href: string
  available: boolean
  children: ReactNode
}) {
  const className =
    "flex min-h-12 items-center justify-center rounded-2xl px-5 text-sm font-black transition sm:min-h-14 sm:px-7"

  if (!available) {
    return (
      <span className={`${className} cursor-not-allowed border border-white/10 bg-white/[0.04] text-white/35`}>
        {children}
      </span>
    )
  }

  return (
    <a href={href} download={href.startsWith("/") ? true : undefined} className={`${className} bg-cyan-300 text-black shadow-[0_0_44px_rgba(34,211,238,0.22)] hover:bg-cyan-200`}>
      {children}
    </a>
  )
}

function InstallerCard({
  href,
  info,
  label,
}: {
  href: string
  info: InstallerInfo
  label: string
}) {
  return (
    <div>
      <DownloadButton href={info.href || href} available={info.available}>
        {label}
      </DownloadButton>
      <p className="mt-2 text-center text-xs font-bold text-white/45">
        {info.statusLabel}
      </p>
    </div>
  )
}

function MobileInstallCard({
  label,
  description,
  steps,
}: {
  label: string
  description: string
  steps: string
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
      <div className="flex min-h-12 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-5 text-sm font-black text-cyan-100 sm:min-h-14">
        {label}
      </div>
      <p className="mt-3 text-sm leading-6 text-white/58">{description}</p>
      <p className="mt-2 text-xs font-bold text-white/42">{steps}</p>
    </div>
  )
}

export default function DownloadPage() {
  const desktopReleaseManifest = readDesktopReleaseManifest()
  const macInstaller = getInstallerInfo(macInstallerPath, {
    requiresReleaseManifest: true,
    releaseEntry: desktopReleaseManifest?.mac,
    manifestVersion: desktopReleaseManifest?.version,
    platform: "mac",
  })
  const windowsInstaller = getInstallerInfo(windowsInstallerPath, {
    releaseEntry: desktopReleaseManifest?.windows,
    manifestVersion: desktopReleaseManifest?.version,
    platform: "windows",
  })
  const installersReady = macInstaller.available || windowsInstaller.available

  return (
    <main className="min-h-dvh overflow-x-hidden bg-[#020403] px-5 py-8 text-white sm:py-10 lg:px-8">
      <section className="mx-auto flex min-h-[calc(100dvh-80px)] w-full min-w-0 max-w-5xl flex-col justify-center">
        <Link href="/" className="mb-10 inline-flex w-fit max-w-full min-w-0 items-center gap-3 text-sm font-black text-cyan-100 hover:text-white">
          <BezgrowLogoMark className="h-10 w-10" size={40} />
          Bezgrow
        </Link>

        <div className="w-full min-w-0 overflow-hidden rounded-[22px] border border-white/10 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.35)] sm:rounded-[28px] sm:p-8 lg:p-10">
          <p className="text-xs font-black uppercase tracking-[0.22em] text-cyan-200">Desktop ERP</p>
          <h1 className="mt-4 break-words text-3xl font-black leading-tight tracking-tight sm:text-5xl">Bezgrow Desktop App</h1>
          <p className="mt-4 max-w-2xl break-words leading-8 text-white/62">
            Install Bezgrow on your computer for desktop ERP workflows, persistent login, local offline data, printing, and sync when internet returns.
          </p>

          <div className="mt-6 inline-flex rounded-full border border-white/10 bg-black/35 px-4 py-2 text-sm font-bold text-white/65">
            Version {packageJson.version}
          </div>

          {!installersReady && (
            <div className="mt-6 break-words rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100">
              {macInstaller.blockedReason || "Desktop installers are being prepared. Please contact support."}
            </div>
          )}

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <InstallerCard href={macInstallerPath} info={macInstaller} label="Download for Mac" />
            <InstallerCard href={windowsInstallerPath} info={windowsInstaller} label="Download for Windows" />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <MobileInstallCard
              label="Install on Android"
              description="Open Bezgrow in Chrome and install the web app from the browser menu."
              steps="Chrome menu > Add to Home screen"
            />
            <MobileInstallCard
              label="Install on iPhone"
              description="Open Bezgrow in Safari and add it to your Home Screen."
              steps="Share > Add to Home Screen"
            />
          </div>

          <div className="mt-8 grid gap-4 text-sm leading-7 text-white/58 md:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <h2 className="text-base font-black text-white">1. Download</h2>
              <p className="mt-2">Choose the installer for your operating system.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <h2 className="text-base font-black text-white">2. Install</h2>
              <p className="mt-2">Open the installer and follow your system prompts.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <h2 className="text-base font-black text-white">3. Sign In</h2>
              <p className="mt-2">Log in once online, then Bezgrow can reopen with local offline data.</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
