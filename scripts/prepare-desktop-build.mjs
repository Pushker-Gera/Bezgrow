import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const standaloneDir = join(root, ".next", "standalone");
const desktopServerDir = join(root, "desktop-runtime", "next-server");
const desktopNodeDir = join(root, "desktop-runtime", "node");

rmSync(standaloneDir, { recursive: true, force: true });
rmSync(desktopServerDir, { recursive: true, force: true });
rmSync(desktopNodeDir, { recursive: true, force: true });

const build = spawnSync(process.execPath, [join(root, "scripts", "build-next.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    BEZGROW_DESKTOP_BUILD: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    SUPABASE_SERVICE_ROLE_KEY: "",
    BEZGROW_LICENSE_PRIVATE_KEY: "",
    WINDOWS_CERTIFICATE_BASE64: "",
    WINDOWS_CERTIFICATE_PASSWORD: "",
    BEZGROW_WINDOWS_CERTIFICATE_BASE64: "",
    BEZGROW_WINDOWS_CERTIFICATE_PASSWORD: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  },
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const staticSource = join(root, ".next", "static");
const staticTarget = join(standaloneDir, ".next", "static");
const serverSource = join(root, ".next", "server");
const serverTarget = join(standaloneDir, ".next", "server");
const publicSource = join(root, "public");
const publicTarget = join(standaloneDir, "public");

function shouldCopyPublicAsset(source) {
  const relativePath = relative(publicSource, source);
  return relativePath !== "downloads" && !relativePath.startsWith(`downloads${sep}`);
}

if (!existsSync(join(standaloneDir, "server.js"))) {
  throw new Error("Next standalone server was not generated. Check BEZGROW_DESKTOP_BUILD output mode.");
}

rmSync(staticTarget, { recursive: true, force: true });
mkdirSync(dirname(staticTarget), { recursive: true });
cpSync(staticSource, staticTarget, { recursive: true });

for (const requiredServerAsset of ["chunks", "interception-route-rewrite-manifest.js"]) {
  const source = join(serverSource, requiredServerAsset);
  const target = join(serverTarget, requiredServerAsset);
  if (existsSync(source)) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

rmSync(publicTarget, { recursive: true, force: true });
if (existsSync(publicSource)) {
  cpSync(publicSource, publicTarget, { recursive: true, filter: shouldCopyPublicAsset });
}

rmSync(desktopServerDir, { recursive: true, force: true });
mkdirSync(desktopServerDir, { recursive: true });
cpSync(standaloneDir, desktopServerDir, { recursive: true });
writeFileSync(join(desktopServerDir, ".gitkeep"), "");

rmSync(desktopNodeDir, { recursive: true, force: true });
mkdirSync(desktopNodeDir, { recursive: true });

const targetTriple = process.env.BEZGROW_DESKTOP_TARGET || "";
const targetsWindows = targetTriple.includes("windows") || (!targetTriple && process.platform === "win32");
const targetArchitecture = targetTriple.startsWith("aarch64")
  ? "arm64"
  : targetTriple.startsWith("x86_64")
    ? "x64"
    : process.arch;
const crossArchitectureWindowsBuild =
  targetsWindows && ((targetArchitecture === "arm64" && process.arch !== "arm64") || (targetArchitecture === "x64" && process.arch !== "x64"));
const requestedNodeBinary = process.env.BEZGROW_DESKTOP_NODE_BINARY;

if (crossArchitectureWindowsBuild && !requestedNodeBinary) {
  throw new Error(
    `The ${targetArchitecture} Windows build requires BEZGROW_DESKTOP_NODE_BINARY to point to a native ${targetArchitecture} node.exe.`
  );
}

const nodeSource = requestedNodeBinary || process.execPath;
if (!existsSync(nodeSource)) {
  throw new Error(`The requested bundled Node runtime does not exist: ${nodeSource}`);
}

const nodeExecutableName = targetsWindows ? "node.exe" : "node";
const nodeTarget = join(desktopNodeDir, nodeExecutableName);
copyFileSync(nodeSource, nodeTarget);
if (process.platform !== "win32") chmodSync(nodeTarget, 0o755);
writeFileSync(join(desktopNodeDir, ".gitkeep"), "");
