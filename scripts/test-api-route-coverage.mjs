import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const source = readFileSync("lib/offline/local/api.ts", "utf8");
const localEndpoints = Array.from(source.matchAll(/"(\/api\/[^"]+)"/g))
  .map((match) => match[1])
  .filter((endpoint, index, all) => all.indexOf(endpoint) === index)
  .sort();

const catchAllHandlerExists = existsSync("app/api/[...erp]/route.ts");
const missing = localEndpoints.filter((endpoint) => {
  const routeFile = `app${endpoint}/route.ts`;
  return !existsSync(routeFile) && !catchAllHandlerExists;
});

assert.equal(missing.length, 0, `Missing API route handlers:\n${missing.join("\n")}`);
assert.ok(localEndpoints.length >= 50, "Expected local API endpoint coverage to stay broad.");

console.log(`api-route-coverage-ok endpoints=${localEndpoints.length}`);
