import "server-only"

import { NextResponse } from "next/server"
import {
  DESKTOP_ADMIN_PAGE_COOKIE,
  desktopAdminPageCookieOptions,
} from "@/lib/desktop/runtime-admin-session"

export const dynamic = "force-dynamic"

export function DELETE() {
  const response = NextResponse.json(
    { success: true },
    { headers: { "Cache-Control": "no-store" } },
  )
  response.cookies.set(DESKTOP_ADMIN_PAGE_COOKIE, "", {
    ...desktopAdminPageCookieOptions,
    maxAge: 0,
  })
  return response
}
