export const preparedRuntimePlaceholderPaths = new Set([
  "desktop-runtime/next-server/.gitkeep",
  "desktop-runtime/node/.gitkeep",
]);

export function hasUnexpectedTrackedChanges(porcelainOutput, preparedMode) {
  return (porcelainOutput || "")
    .split("\0")
    .filter(Boolean)
    .some((entry) => {
      if (!preparedMode) return true;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      return status !== " D" || !preparedRuntimePlaceholderPaths.has(path);
    });
}
