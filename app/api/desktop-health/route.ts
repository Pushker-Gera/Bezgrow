import { timingSafeEqual } from "node:crypto"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

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

  return NextResponse.json(
    {
      status: "ok",
      runtime: "bezgrow-embedded",
      appVersion,
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
