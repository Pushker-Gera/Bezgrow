import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function getRequestOrigin(req: Request) {
    const url = new URL(req.url)
    const forwardedHost = req.headers.get("x-forwarded-host")
    const forwardedProto = req.headers.get("x-forwarded-proto") || "https"
    const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL
    const vercelUrl = process.env.VERCEL_URL

    if (forwardedHost) {
        return `${forwardedProto}://${forwardedHost}`
    }

    if (configuredSiteUrl && !configuredSiteUrl.includes("localhost")) {
        return configuredSiteUrl
    }

    if (vercelUrl) {
        return `https://${vercelUrl}`
    }

    if (url.origin && !url.origin.includes("localhost")) {
        return url.origin
    }

    return configuredSiteUrl || url.origin
}

export async function GET(req: Request) {

    try {

        const { searchParams } = new URL(req.url)
        const origin = getRequestOrigin(req)

        const userId = searchParams.get("userId")

        if (!userId) {

            return NextResponse.json({
                success: false
            })

        }

        // update status

        const { error } = await supabase
            .from("pending_users")
            .update({
                status: "approved"
            })
            .eq("user_id", userId)

        if (error) {

            console.error(error)

            return NextResponse.json({
                success: false,
                error
            })

        }

        return NextResponse.redirect(`${origin}/admin/users?approval=approved`)

    } catch (error) {

        console.error(error)

        return NextResponse.json({
            success: false,
            error
        })

    }

}
