import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin",
        "/api",
        "/auth",
        "/dashboard",
        "/i/",
        "/login",
        "/offline",
        "/profile",
        "/public/invoices/",
        "/r/",
        "/rejected",
        "/reset-password",
        "/signup",
      ],
    },
    sitemap: "https://www.bezgrow.com/sitemap.xml",
  }
}
