import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildResolverSource, HOOK_MARKER } from "./hook-resolver.js";

function runResolver(cwd: string, env: Record<string, string>) {
  const script = join(cwd, "resolve.mjs");
  writeFileSync(script, `${buildResolverSource()}\nprocess.stdout.write(distDir);\n`);
  const started = Date.now();
  const res = spawnSync(process.execPath, [script], {
    cwd, encoding: "utf8",
    env: { ...process.env, DEV_MEM_SKIP_NPM: "1", DEV_MEM_DIST_DIR: "", ...env },
  });
  return { out: res.stdout.trim().replace(/\\/g, "/"), status: res.status, ms: Date.now() - started };
}

function fakeInstall(root: string): string {
  const dist = join(root, "dev-memo", "dist");
  mkdirSync(join(dist, "adapters"), { recursive: true });
  return dist.replace(/\\/g, "/");
}

describe("hook resolver", () => {
  let project: string;
  let globalRoot: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "dm-res-proj-"));
    mkdirSync(join(project, ".dev-mem"));
    globalRoot = mkdtempSync(join(tmpdir(), "dm-res-root-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
  });

  it("exports a version marker", () => {
    expect(HOOK_MARKER).toBe("// dev-mem-hook-v2");
  });

  it("prefers DEV_MEM_DIST_DIR", () => {
    const dist = fakeInstall(globalRoot);
    expect(runResolver(project, { DEV_MEM_DIST_DIR: dist }).out).toBe(dist);
  });

  it("uses a valid cache file", () => {
    const dist = fakeInstall(globalRoot);
    writeFileSync(join(project, ".dev-mem", "install-path.txt"), dist);
    expect(runResolver(project, {}).out).toBe(dist);
  });

  it("ignores a stale cache and falls back to a known global root, then rewrites the cache", () => {
    writeFileSync(join(project, ".dev-mem", "install-path.txt"), "/does/not/exist");
    const dist = fakeInstall(globalRoot);
    const r = runResolver(project, { DEV_MEM_GLOBAL_ROOTS: ["/nope", globalRoot].join(delimiter) });
    expect(r.out).toBe(dist);
    expect(readFileSync(join(project, ".dev-mem", "install-path.txt"), "utf8").replace(/\\/g, "/")).toBe(dist);
  });

  it("returns empty, exits 0, and stays fast when nothing is found", () => {
    const r = runResolver(project, { DEV_MEM_GLOBAL_ROOTS: "/nope", APPDATA: "/nope" });
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(4000);
  });

  it("does not crash when .dev-mem is missing", () => {
    rmSync(join(project, ".dev-mem"), { recursive: true, force: true });
    const dist = fakeInstall(globalRoot);
    const r = runResolver(project, { DEV_MEM_GLOBAL_ROOTS: globalRoot });
    expect(r.status).toBe(0);
    expect(r.out).toBe(dist);
    expect(existsSync(join(project, ".dev-mem"))).toBe(false);
  });
});
