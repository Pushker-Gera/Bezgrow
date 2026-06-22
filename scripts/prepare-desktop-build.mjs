import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const build = spawnSync(npmCommand, ["run", "build"], {
  cwd: root,
  env: {
    ...process.env,
    BEZGROW_DESKTOP_BUILD: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const standaloneDir = join(root, ".next", "standalone");
const desktopServerDir = join(root, "desktop-runtime", "next-server");
const desktopNodeDir = join(root, "desktop-runtime", "node");
const staticSource = join(root, ".next", "static");
const staticTarget = join(standaloneDir, ".next", "static");
const publicSource = join(root, "public");
const publicTarget = join(standaloneDir, "public");

if (!existsSync(join(standaloneDir, "server.js"))) {
  throw new Error("Next standalone server was not generated. Check BEZGROW_DESKTOP_BUILD output mode.");
}

rmSync(staticTarget, { recursive: true, force: true });
mkdirSync(dirname(staticTarget), { recursive: true });
cpSync(staticSource, staticTarget, { recursive: true });

rmSync(publicTarget, { recursive: true, force: true });
if (existsSync(publicSource)) {
  cpSync(publicSource, publicTarget, { recursive: true });
}

rmSync(desktopServerDir, { recursive: true, force: true });
mkdirSync(desktopServerDir, { recursive: true });
cpSync(standaloneDir, desktopServerDir, { recursive: true });
writeFileSync(join(desktopServerDir, ".gitkeep"), "");

rmSync(desktopNodeDir, { recursive: true, force: true });
mkdirSync(desktopNodeDir, { recursive: true });

const nodeExecutableName = process.platform === "win32" ? "node.exe" : "node";
const nodeTarget = join(desktopNodeDir, nodeExecutableName);
copyFileSync(process.execPath, nodeTarget);
chmodSync(nodeTarget, 0o755);
writeFileSync(join(desktopNodeDir, ".gitkeep"), "");
