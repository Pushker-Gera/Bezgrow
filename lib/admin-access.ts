const fallbackAdminEmails = ["pushkergera@gmail.com"]

export function isConfiguredAdminEmail(email: string | null | undefined) {
  const normalizedEmail = String(email || "").trim().toLowerCase()
  if (!normalizedEmail) return false

  const configuredEmails = [
    process.env.PLATFORM_ADMIN_EMAILS,
    process.env.ADMIN_EMAILS,
    process.env.NEXT_PUBLIC_ADMIN_EMAILS,
  ]
    .join(",")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

  return [...configuredEmails, ...fallbackAdminEmails].includes(normalizedEmail)
}
