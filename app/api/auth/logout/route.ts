import { cookies } from "next/headers"
import { fail, ok } from "@/lib/api/responses"

export const dynamic = "force-dynamic"
const DESKTOP_AUTH_MARKER_COOKIE = "bezgrow_desktop_auth"

function validMutationOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function isAuthenticationCookie(name: string) {
  return (
    name === DESKTOP_AUTH_MARKER_COOKIE ||
    (name.startsWith("sb-") && name.includes("-auth-token"))
  )
}

export async function POST(request: Request) {
  if (!validMutationOrigin(request)) return fail("Invalid request origin.", 403)

  const cookieStore = await cookies()
  for (const cookie of cookieStore.getAll()) {
    if (isAuthenticationCookie(cookie.name)) cookieStore.delete(cookie.name)
  }

  return ok(
    { loggedOut: true },
    {
      headers: {
        "Cache-Control": "no-store",
        "Clear-Site-Data": '"cache"',
      },
    }
  )
}
