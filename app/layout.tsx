import "./globals.css"
import ChunkReloadGuard from "@/components/chunk-reload-guard"

export const metadata = {
  title: "Bezgrow",
  description: "Business Management Software",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {

  return (

    <html lang="en">

      <body>

        <ChunkReloadGuard />

        {children}

      </body>

    </html>

  )

}
