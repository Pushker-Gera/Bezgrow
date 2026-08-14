import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");

// Next can incrementally reuse output from another commit or build mode. A
// release must never package those bytes, so every production build starts
// from an empty generated output directory. This touches repository build
// output only; desktop application data lives outside the repository.
rmSync(join(root, ".next"), { recursive: true, force: true });
rmSync(join(root, "out"), { recursive: true, force: true });

const result = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
