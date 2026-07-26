export const dynamic = "force-dynamic"

export async function GET() {
  return new Response("Invoice not found.", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
