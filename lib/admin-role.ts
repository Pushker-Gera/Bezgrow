export function isConfiguredAdmin(email: string | null | undefined, role?: string | null) {
  if (role === "admin") return true

  const configuredAdminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  if (!configuredAdminEmail || !email) return false

  return email.trim().toLowerCase() === configuredAdminEmail
}
