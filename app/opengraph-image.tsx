import { ImageResponse } from "next/og"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export const alt = "Bezgrow cloud inventory management, GST billing, POS and ERP software"
export const size = {
  width: 1200,
  height: 630,
}
export const contentType = "image/png"
export const runtime = "nodejs"

export default async function Image() {
  const logo = await readFile(join(process.cwd(), "public", "icon-512.png"))
  const logoUrl = `data:image/png;base64,${logo.toString("base64")}`

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#020403",
          color: "white",
          padding: "72px",
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "24px",
            marginBottom: "48px",
          }}
        >
          <img
            src={logoUrl}
            alt=""
            width="88"
            height="88"
            style={{
              width: "88px",
              height: "88px",
              borderRadius: "28px",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: "54px", fontWeight: 900 }}>Bezgrow</div>
            <div style={{ fontSize: "22px", color: "#a5f3fc", letterSpacing: "0.18em" }}>BUSINESS CLOUD</div>
          </div>
        </div>
        <div style={{ maxWidth: "980px", fontSize: "76px", lineHeight: 1, fontWeight: 900 }}>
          Inventory Management, GST Billing & ERP Software
        </div>
        <div style={{ marginTop: "32px", maxWidth: "900px", fontSize: "30px", lineHeight: 1.35, color: "#cbd5e1" }}>
          Cloud software for retail, wholesale, POS, billing, invoices, analytics, and business management.
        </div>
      </div>
    ),
    size
  )
}
