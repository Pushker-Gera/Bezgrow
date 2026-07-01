import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import Link from "next/link"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import packageJson from "@/package.json"

const macInstallerPath = "/downloads/Bezgrow-mac.dmg"
const windowsInstallerPaths = ["/downloads/Bezgrow-windows.exe", "/downloads/Bezgrow-windows.msi"]
const webAppUrl = "https://www.bezgrow.com"

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
  notarized?: boolean
  signed?: boolean
}

type DesktopReleaseManifest = {
  version?: string
  mac?: {
    url?: string
    file?: string
    size?: number
    notarized?: boolean
  }
  windows?: {
    url?: string
    file?: string
    size?: number
    signed?: boolean
  }
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

function readDesktopReleaseManifest() {
  const manifestPath = join(process.cwd(), "public", "downloads", "desktop-release.json")
  if (!existsSync(manifestPath)) return null

  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as DesktopReleaseManifest
  } catch {
    return null
  }
}

function readReleaseManifest(path: string) {
  const fullPath = join(process.cwd(), "public", path.replace(/^\/+/, ""))
  const manifestPath = `${fullPath}.release.json`
  if (!existsSync(manifestPath)) return null

  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as { notarized?: boolean; signed?: boolean; version?: string }
  } catch {
    return null
  }
}

function getInstallerInfo(
  paths: string | string[],
  missingStatusLabel: string,
  releaseInfo?: DesktopReleaseManifest["mac"] | DesktopReleaseManifest["windows"] | null,
  releaseVersion?: string
): InstallerInfo {
  if (releaseInfo?.url) {
    const sizeLabel = releaseInfo.size ? formatFileSize(releaseInfo.size) : null
    const version = releaseVersion || packageJson.version
    return {
      available: true,
      href: releaseInfo.url,
      sizeLabel,
      notarized: "notarized" in releaseInfo ? releaseInfo.notarized : undefined,
      signed: "signed" in releaseInfo ? releaseInfo.signed : undefined,
      statusLabel: `Version ${version}${sizeLabel ? ` | ${sizeLabel}` : ""}`,
    }
  }

  const candidates = Array.isArray(paths) ? paths : [paths]
  const releaseFile = releaseInfo?.file && releaseInfo.file.startsWith("/") ? releaseInfo.file : null
  const releaseCandidates = releaseFile ? [releaseFile, ...candidates] : candidates
  const path = candidates.find((candidate) => {
    const fullPath = join(process.cwd(), "public", candidate.replace(/^\/+/, ""))
    return existsSync(fullPath) && statSync(fullPath).isFile()
  }) || releaseCandidates.find((candidate) => {
    const fullPath = join(process.cwd(), "public", candidate.replace(/^\/+/, ""))
    return existsSync(fullPath) && statSync(fullPath).isFile()
  })

  if (!path) {
    return { available: false, href: candidates[0], sizeLabel: null, statusLabel: missingStatusLabel }
  }

  const fullPath = join(process.cwd(), "public", path.replace(/^\/+/, ""))
  const sizeLabel = formatFileSize(statSync(fullPath).size)
  const manifest = readReleaseManifest(path)

  return {
    available: true,
    href: path,
    sizeLabel,
    notarized: releaseInfo && "notarized" in releaseInfo ? releaseInfo.notarized : manifest?.notarized,
    signed: releaseInfo && "signed" in releaseInfo ? releaseInfo.signed : manifest?.signed,
    statusLabel: `Version ${releaseVersion || manifest?.version || packageJson.version} | ${sizeLabel}`,
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
    <div className="min-w-0">
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
  href,
}: {
  label: string
  description: string
  steps: string
  href: string
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/10 bg-black/25 p-4">
      <a
        href={href}
        className="flex min-h-12 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-5 text-sm font-black text-cyan-100 transition hover:border-cyan-200/50 hover:bg-cyan-300/15 sm:min-h-14"
      >
        Open Web App
      </a>
      <h2 className="mt-4 text-base font-black text-white">{label}</h2>
      <p className="mt-3 text-sm leading-6 text-white/58 [overflow-wrap:anywhere]">{description}</p>
      <p className="mt-2 text-xs font-bold text-white/42 [overflow-wrap:anywhere]">{steps}</p>
    </div>
  )
}

export default function DownloadPage() {
  const releaseManifest = readDesktopReleaseManifest()
  const macInstaller = getInstallerInfo(macInstallerPath, "Mac installer not found.", releaseManifest?.mac, releaseManifest?.version)
  const windowsInstaller = getInstallerInfo(
    windowsInstallerPaths,
    "Windows installer not found on this build.",
    releaseManifest?.windows,
    releaseManifest?.version
  )
  const installersReady = macInstaller.available || windowsInstaller.available
  const showMacNotarizationWarning = macInstaller.available && macInstaller.notarized !== true

  return (
    <main className="min-h-dvh overflow-x-hidden bg-[#020403] px-4 py-8 text-white sm:px-5 sm:py-10 lg:px-8">
      <section className="mx-auto flex min-h-[calc(100dvh-80px)] w-full min-w-0 max-w-5xl flex-col justify-center overflow-hidden">
        <Link href="/" className="mb-10 inline-flex w-fit max-w-full min-w-0 items-center gap-3 text-sm font-black text-cyan-100 hover:text-white">
          <BezgrowLogoMark className="h-10 w-10" size={40} />
          Bezgrow
        </Link>

        <div className="w-full max-w-[calc(100vw-2rem)] min-w-0 overflow-hidden rounded-[22px] border border-white/10 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.35)] sm:max-w-none sm:rounded-[28px] sm:p-8 lg:p-10">
          <p className="text-xs font-black uppercase tracking-[0.22em] text-cyan-200">Desktop ERP</p>
          <h1 className="mt-4 break-words text-3xl font-black leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-5xl">Bezgrow Desktop App</h1>
          <p className="mt-4 max-w-2xl break-words leading-8 text-white/62 [overflow-wrap:anywhere]">
            Install Bezgrow on your computer for desktop ERP workflows, persistent login, local offline data, printing, and sync when internet returns.
          </p>

          <div className="mt-6 inline-flex rounded-full border border-white/10 bg-black/35 px-4 py-2 text-sm font-bold text-white/65">
            Version {packageJson.version}
          </div>

          {!installersReady && (
            <div className="mt-6 break-words rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100 [overflow-wrap:anywhere]">
              Desktop installers are being prepared. Please contact support.
            </div>
          )}

          {showMacNotarizationWarning && (
            <div className="mt-6 break-words rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100 [overflow-wrap:anywhere]">
              macOS may show a security warning until notarization is completed.
            </div>
          )}

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <InstallerCard href={macInstallerPath} info={macInstaller} label="Download for Mac" />
            <InstallerCard href={windowsInstallerPaths[0]} info={windowsInstaller} label="Download for Windows" />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <MobileInstallCard
              label="Install on Android"
              href={webAppUrl}
              description="Open Bezgrow in Chrome, then use the browser menu to add it to your Home screen or install the app."
              steps="Chrome menu -> Add to Home screen / Install app"
            />
            <MobileInstallCard
              label="Install on iPhone"
              href={webAppUrl}
              description="Open Bezgrow in Safari, then use Share to add it to your Home Screen."
              steps="Share -> Add to Home Screen"
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
