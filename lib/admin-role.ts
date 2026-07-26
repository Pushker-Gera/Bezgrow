export function isConfiguredAdmin(email: string | null | undefined, role?: string | null) {
  void email
  return role === "admin" || role === "platform_admin"
}
