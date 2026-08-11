import { timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type DesktopBuildIdentity = {
  applicationVersion?: string
  gitCommit?: string
  builtAt?: string
  platform?: string
  architecture?: string
  sourceTreeDirty?: boolean
}

function desktopBuildIdentity() {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), "public", "desktop-build.json"), "utf8")
    ) as DesktopBuildIdentity
  } catch {
    return null
  }
}

function sameRuntimeToken(supplied: string | null, expected: string | undefined) {
  if (!supplied || !expected) return false
  const suppliedBytes = Buffer.from(supplied, "utf8")
  const expectedBytes = Buffer.from(expected, "utf8")
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
}

export function GET(request: Request) {
  const url = new URL(request.url)
  const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost"
  const runtimeToken = request.headers.get("x-bezgrow-runtime-token")
  if (
    process.env.BEZGROW_DESKTOP_BUILD !== "1" ||
    url.protocol !== "http:" ||
    !localHost ||
    !sameRuntimeToken(runtimeToken, process.env.BEZGROW_RUNTIME_TOKEN)
  ) {
    return NextResponse.json({ status: "not_found" }, { status: 404 })
  }

  const shellPid = Number(process.env.BEZGROW_RUNTIME_SHELL_PID)
  const appVersion = process.env.BEZGROW_RUNTIME_VERSION
  if (!appVersion || !Number.isSafeInteger(shellPid) || shellPid <= 0) {
    return NextResponse.json({ status: "runtime_invalid" }, { status: 503 })
  }
  const build = desktopBuildIdentity()
  if (
    !build ||
    build.applicationVersion !== appVersion ||
    !/^[a-f0-9]{40}$/i.test(build.gitCommit || "") ||
    Number.isNaN(Date.parse(build.builtAt || "")) ||
    !["macos", "windows", "linux"].includes(build.platform || "") ||
    !["arm64", "x64"].includes(build.architecture || "")
  ) {
    return NextResponse.json({ status: "build_identity_invalid" }, { status: 503 })
  }

  return NextResponse.json(
    {
      status: "ok",
      runtime: "bezgrow-embedded",
      appVersion,
      gitCommit: build.gitCommit,
      buildTimestamp: build.builtAt,
      platform: build.platform,
      architecture: build.architecture,
      sourceTreeDirty: build.sourceTreeDirty === true,
      shellPid,
      serverPid: process.pid,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  )
}
