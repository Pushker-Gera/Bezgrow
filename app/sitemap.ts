import type { MetadataRoute } from "next"

const siteUrl = "https://bezgrow.com"

const publicRoutes = [
  {
    path: "",
    priority: 1,
    changeFrequency: "weekly" as const,
  },
  {
    path: "/login",
    priority: 0.5,
    changeFrequency: "monthly" as const,
  },
  {
    path: "/signup",
    priority: 0.8,
    changeFrequency: "monthly" as const,
  },
  {
    path: "/reset-password",
    priority: 0.2,
    changeFrequency: "yearly" as const,
  },
  {
    path: "/pending-approval",
    priority: 0.2,
    changeFrequency: "yearly" as const,
  },
  {
    path: "/rejected",
    priority: 0.1,
    changeFrequency: "yearly" as const,
  },
]

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date()

  return publicRoutes.map((route) => ({
    url: `${siteUrl}${route.path}`,
    lastModified: now,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }))
}
