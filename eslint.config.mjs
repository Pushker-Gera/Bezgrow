import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next.generated-stale-*/**",
    "out/**",
    "build/**",
    "dist/**",
    "desktop-runtime/.next-stale-*/**",
    "desktop-runtime/.standalone-stale-*/**",
    "desktop-runtime/next-server/**",
    "src-tauri/target/**",
    "pushker-dashboard/dist/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
