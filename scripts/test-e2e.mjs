import { existsSync, readFileSync } from "node:fs";

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function valueFor(localEnv, key) {
  return (process.env[key] || localEnv[key] || "").trim();
}

const localEnv = readEnvFile(".env.e2e");
const required = [
  "BEZGROW_E2E_ADMIN_EMAIL",
  "BEZGROW_E2E_ADMIN_PASSWORD",
  "BEZGROW_E2E_USER_EMAIL",
  "BEZGROW_E2E_USER_PASSWORD",
  "BEZGROW_E2E_BASE_URL",
];
const missing = required.filter((key) => !valueFor(localEnv, key));
const issues = [];

if (missing.length) {
  issues.push(`missing required E2E variables: ${missing.join(", ")}`);
}

try {
  await import("@playwright/test");
} catch {
  issues.push("Playwright test runner is not installed as a project dependency");
}

const hasTests = [
  "e2e",
  "tests/e2e",
  "playwright.config.ts",
  "playwright.config.mjs",
  "playwright.config.js",
].some((path) => existsSync(path));

if (!hasTests) {
  issues.push("no Playwright E2E suite or config exists in the repository");
}

if (issues.length) {
  console.error("E2E test run blocked:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log("e2e-ready");
