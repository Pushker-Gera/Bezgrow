import { NextResponse } from "next/server"

type ApiMeta = Record<string, unknown>

export function ok<T extends ApiMeta>(payload: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, ...payload }, init)
}

export function fail(message = "Request failed.", status = 400, meta?: ApiMeta) {
  return NextResponse.json({ success: false, error: message, ...meta }, { status })
}

export function serverFail() {
  return fail("Something went wrong. Please try again.", 500)
}
