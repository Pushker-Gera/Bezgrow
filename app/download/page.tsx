import Link from "next/link"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import {
  getDesktopReleaseAvailability,
  type PublicReleaseAvailability,
} from "@/lib/releases/public"

const macInstallerPath = "/api/downloads/desktop?platform=mac"
const windowsInstallerPath = "/api/downloads/desktop?platform=windows"
const webAppUrl = "https://www.bezgrow.com"

export const dynamic = "force-dynamic"
export const revalidate = 0

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
  warning: string | null
  blockedReason: string | null
  platform: "macos" | "windows"
  version?: string | null
  architecture?: string | null
  sha256?: string | null
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

function getInstallerInfo(
  release: PublicReleaseAvailability,
  fallbackHref: string
): InstallerInfo {
  const sizeLabel = release.size ? formatFileSize(release.size) : null
  const statusParts = [
    release.version ? `Version ${release.version}` : null,
    release.platform === "windows" ? "Windows 10/11" : null,
    release.architecture
      ? release.architecture === "x86_64"
        ? "x64"
        : release.architecture.toUpperCase()
      : null,
    sizeLabel,
    release.checksumVerified ? "SHA-256 verified" : null,
    release.signed ? "Code signed" : "Unsigned",
    release.platform === "macos"
      ? release.notarized
        ? "Notarized"
        : "Not notarized"
      : null,
    release.filename?.toLowerCase().endsWith(".msi")
      ? "MSI"
      : release.platform === "windows"
        ? "NSIS EXE"
        : "DMG",
  ].filter(Boolean)
  return {
    available: release.available,
    href: fallbackHref,
    sizeLabel,
    warning: release.warning,
    blockedReason: release.blockedReason,
    platform: release.platform,
    version: release.version,
    architecture: release.architecture,
    sha256: release.sha256,
    statusLabel: release.available ? statusParts.join(" · ") : release.blockedReason || release.reason,
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
      <button
        type="button"
        disabled
        className={`${className} w-full cursor-not-allowed border border-white/10 bg-white/[0.04] text-white/35`}
      >
        {children}
      </button>
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
  const downloadHref = info.available ? info.href : info.href || href

  return (
    <div className="min-w-0">
      <DownloadButton href={downloadHref} available={info.available}>
        {label}
      </DownloadButton>
      <p className="mt-2 text-center text-xs font-bold text-white/45">
        {info.statusLabel}
      </p>
      {info.available && info.sha256 && (
        <p className="mt-2 text-center text-[11px] font-semibold text-white/40">
          SHA-256: <code className="break-all text-white/55">{info.sha256}</code>
        </p>
      )}
      {info.warning && (
        <div className="mt-3 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold leading-6 text-amber-100">
          <p>{info.warning}</p>
          {info.platform === "macos" && (
            <p className="mt-1 text-xs font-semibold text-amber-100/70">
              If macOS blocks the first launch, right-click the Bezgrow app, choose Open, then confirm.
            </p>
          )}
        </div>
      )}
      {!info.available && info.blockedReason && (
        <div className="mt-3 rounded-2xl border border-red-300/20 bg-red-300/10 px-4 py-3 text-xs font-bold leading-5 text-red-100">
          {info.blockedReason}
        </div>
      )}
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

export default async function DownloadPage() {
  const availability = await getDesktopReleaseAvailability()
  const releaseManifest = availability.manifest
  const macInstaller = getInstallerInfo(availability.mac, macInstallerPath)
  const windowsInstaller = getInstallerInfo(availability.windows, windowsInstallerPath)
  const installersReady = macInstaller.available || windowsInstaller.available
  const releaseNotes = [
    availability.mac.releaseNotes,
    availability.windows.releaseNotes,
  ].filter((note, index, notes): note is string => Boolean(note) && notes.indexOf(note) === index)

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
            {releaseManifest?.version
              ? `Available desktop release ${releaseManifest.version}`
              : "No validated desktop installer available"}
          </div>

          {!installersReady && (
            <div className="mt-6 break-words rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100 [overflow-wrap:anywhere]">
              No genuine desktop installer currently passes file-integrity validation. Platform-specific reasons are shown below.
            </div>
          )}

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <InstallerCard
              href={macInstallerPath}
              info={macInstaller}
              label={`Download for Mac${macInstaller.version ? ` · v${macInstaller.version}` : ""}`}
            />
            <InstallerCard
              href={windowsInstallerPath}
              info={windowsInstaller}
              label={`Download for Windows${windowsInstaller.version ? ` · v${windowsInstaller.version}` : ""}`}
            />
          </div>

          {releaseNotes.length > 0 && (
            <details className="mt-6 rounded-2xl border border-white/10 bg-black/25 p-4">
              <summary className="cursor-pointer text-sm font-black text-cyan-100">Release notes</summary>
              <div className="mt-3 space-y-2 text-sm leading-6 text-white/60">
                {releaseNotes.map((note) => <p key={note}>{note}</p>)}
              </div>
            </details>
          )}

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
