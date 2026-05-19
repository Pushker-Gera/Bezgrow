import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: Request) {

    try {

        const { searchParams } = new URL(req.url)

        const userId = searchParams.get("userId")

        await supabase
            .from("pending_users")
            .update({
                status: "rejected"
            })
            .eq("user_id", userId)

        return NextResponse.redirect(
            `${process.env.NEXT_PUBLIC_SITE_URL}/rejected-success`
        )

    } catch (error) {

        console.error(error)

        return NextResponse.json({
            success: false,
            error
        })

    }

}