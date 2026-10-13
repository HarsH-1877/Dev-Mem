/**
 * Builds the ESM source that installed hook scripts use to locate the
 * dev-memo dist directory at runtime, so no machine-specific path is ever
 * written into a committed hook file.
 */
export const HOOK_MARKER = "// dev-mem-hook-v2";

export function buildResolverSource(): string {
  return `${HOOK_MARKER}
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const __devMemCache = join(process.cwd(), ".dev-mem", "install-path.txt");
const __devMemValid = (d) => { try { return !!d && existsSync(join(d, "adapters")); } catch { return false; } };
const __devMemSave = (d) => { try { if (existsSync(dirname(__devMemCache))) writeFileSync(__devMemCache, d, "utf8"); } catch {} };

let distDir = "";

if (__devMemValid(process.env.DEV_MEM_DIST_DIR)) distDir = process.env.DEV_MEM_DIST_DIR;

if (!distDir) {
  try { const c = readFileSync(__devMemCache, "utf8").trim(); if (__devMemValid(c)) distDir = c; } catch {}
}

if (!distDir) {
  try {
    const p = join(fileURLToPath(import.meta.resolve("dev-memo/package.json")), "..", "dist");
    if (__devMemValid(p)) { distDir = p; __devMemSave(p); }
  } catch {}
}

if (!distDir) {
  const exeDir = dirname(process.execPath);
  const roots = [
    ...(process.env.DEV_MEM_GLOBAL_ROOTS ? process.env.DEV_MEM_GLOBAL_ROOTS.split(delimiter) : []),
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : "",
    join(exeDir, "node_modules"),
    join(exeDir, "..", "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
  ];
  for (const r of roots) {
    const p = r ? join(r, "dev-memo", "dist") : "";
    if (__devMemValid(p)) { distDir = p; __devMemSave(p); break; }
  }
}

if (!distDir && process.env.DEV_MEM_SKIP_NPM !== "1") {
  try {
    const root = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32",
    }).trim();
    const p = join(root, "dev-memo", "dist");
    if (__devMemValid(p)) { distDir = p; __devMemSave(p); }
  } catch {}
}
`;
}
