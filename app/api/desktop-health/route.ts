import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export function GET(request: Request) {
  const url = new URL(request.url)
  const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost"
  if (process.env.BEZGROW_DESKTOP_BUILD !== "1" || url.protocol !== "http:" || !localHost) {
    return NextResponse.json({ status: "not_found" }, { status: 404 })
  }

  return NextResponse.json(
    {
      status: "ok",
      runtime: "bezgrow-embedded",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  )
}
