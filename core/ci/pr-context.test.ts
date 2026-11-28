import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { GraphStore } from "../graph/index.js";
import { exportSharedGraph } from "../sync/index.js";
import { runPrContext } from "./pr-context.js";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@dev-mem.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# PR Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

const EV = {
  commit: "1111111111111111111111111111111111111111",
  session_id: "s-pr",
  agent: "claude-code",
  timestamp: "2026-10-16T00:00:00.000Z",
  confidence: 0.92,
};

describe("PR Context & Green-Merge Verification (core/ci/pr-context.ts)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-pr-ctx-"));
    initGitRepo(dir);
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // ignore transient Windows locks
    }
  });

  it("imports shared.jsonl on a clean runner and renders PR markdown with regression warnings and rules", () => {
    // Seed and export to shared.jsonl, then delete SQLite DB to simulate clean GitHub runner
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "Decision",
      title: "Use parameterized SQL for auth queries",
      content: "Never string-interpolate user email into SQL statements.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["src/auth/login.ts"] },
    });
    store.createNode({
      type: "FailedApproach",
      title: "JWT cookie without SameSite caused CSRF bypass",
      content: "Always enforce SameSite=Lax on auth session cookies.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["src/auth/login.ts"] },
    });
    store.close();
    exportSharedGraph(dir);
    rmSync(join(dir, ".dev-mem", "graph.sqlite"), { force: true });

    const res = runPrContext(dir, {
      changedFiles: ["src/auth/login.ts"],
      title: "Refactor auth login handler",
    });

    expect(res.regressionWarnings.length).toBe(1);
    expect(res.relevantNodes.length).toBeGreaterThanOrEqual(1);
    expect(res.markdown).toContain("<!-- dev-mem-pr-context -->");
    expect(res.markdown).toContain("Regression Intelligence");
    expect(res.markdown).toContain("Use parameterized SQL for auth queries");
    expect(res.verifiedNodeIds).toEqual([]);
  });

  it("marks matching non-failure nodes verified and updates MEMORY.md when verifyOnMerge is true", () => {
    const store = new GraphStore({ projectRoot: dir });
    const dNode = store.createNode({
      type: "Decision",
      title: "Use WAL mode on checkout store",
      content: "Concurrent writers require WAL.",
      lifecycle_state: "active",
      evidence: { ...EV, files: ["src/checkout/db.ts"] },
    });
    const fNode = store.createNode({
      type: "FailedApproach",
      title: "In-memory queue dropped crash jobs",
      content: "Avoid non-persistent arrays.",
      lifecycle_state: "observed",
      evidence: { ...EV, files: ["src/checkout/db.ts"] },
    });
    store.close();

    const res = runPrContext(dir, {
      changedFiles: ["src/checkout/db.ts"],
      verifyOnMerge: true,
    });

    expect(res.verifiedNodeIds).toEqual([dNode.id]);
    const check = new GraphStore({ projectRoot: dir });
    expect(check.getNode(dNode.id)?.lifecycle_state).toBe("verified");
    // FailedApproach stays non-verified during auto-merge
    expect(check.getNode(fNode.id)?.lifecycle_state).toBe("observed");
    check.close();
    expect(existsSync(join(dir, ".dev-mem", "MEMORY.md"))).toBe(true);
    expect(readFileSync(join(dir, ".dev-mem", "shared.jsonl"), "utf8")).toContain("verified");
  });
});
