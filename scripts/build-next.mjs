import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
const standaloneDir = join(root, ".next", "standalone");
const generatedRuntimeDir = join(root, "desktop-runtime");

if (existsSync(standaloneDir)) {
  renameSync(standaloneDir, join(generatedRuntimeDir, `.standalone-stale-${Date.now()}`));
}

const result = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
