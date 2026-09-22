/**
 * Tests for dev-mem query and dev-mem inspect CLI commands.
 *
 * Uses a real GraphStore (in-memory) and runs the commands through runCli()
 * so the full code path is exercised — not just that the command doesn't crash.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { GraphStore } from "../core/graph/index.js";
import { runCli } from "./index.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@dev-mem.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

const BASE_EVIDENCE = {
  commit: "abc1234def5678901234567890abcdef12345678",
  session_id: "sess_test",
  agent: "claude-code" as const,
  timestamp: new Date().toISOString(),
  confidence: 0.91,
  symbols: [] as string[],
};

describe("dev-mem query", () => {
  let testDir: string;
  let savedCwd: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "dev-mem-cli-test-"));
    initGitRepo(testDir);
    savedCwd = process.cwd();
    process.chdir(testDir);

    // Populate graph with nodes that have distinct topics
    const store = new GraphStore({ projectRoot: testDir });
    store.createNode({
      type: "Decision",
      title: "Use Firebase Auth for server-side authentication",
      content: "Firebase Admin validates tokens server-side, removing client-side token concerns.",
      evidence: { ...BASE_EVIDENCE, files: ["src/auth/session.ts"] },
    });
    store.createNode({
      type: "FailedApproach",
      title: "Client-side JWT verification caused session inconsistency",
      content: "Verifying tokens on the client led to race conditions and stale sessions.",
      evidence: { ...BASE_EVIDENCE, files: ["src/auth/legacy.ts"], confidence: 0.88 },
    });
    store.createNode({
      type: "Convention",
      title: "All API routes use zod schemas for input validation",
      content: "Validation is enforced at the route layer before any business logic runs.",
      evidence: { ...BASE_EVIDENCE, files: ["src/routes/tasks.ts"], confidence: 0.85 },
    });
    store.close();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns structured §9-format context for a matching task", async () => {
    const result = await runCli(["query", "Implement server-side Firebase authentication"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // Output must be wrapped in <dev_mem_context> (§9 injection format)
    expect(result.stdout).toContain("<dev_mem_context>");
    expect(result.stdout).toContain("</dev_mem_context>");
    // The auth-related node should appear
    expect(result.stdout).toContain("Firebase Auth");
    // Confidence and lifecycle state must be present (§9 format)
    expect(result.stdout).toMatch(/confidence: 0\.\d{2}/);
    // Evidence commit line must be present
    expect(result.stdout).toContain("Evidence: commit");
  });

  it("ranks auth node above unrelated validation node for an auth task", async () => {
    const result = await runCli(["query", "Implement server-side Firebase authentication"]);
    expect(result.exitCode).toBe(0);

    const authIdx = result.stdout.indexOf("Firebase Auth");
    const validationIdx = result.stdout.indexOf("zod schemas");

    // Auth node should appear before or instead of the unrelated validation node
    // (either it appears first, or the validation node is filtered out by the tight budget)
    if (validationIdx !== -1) {
      expect(authIdx).toBeLessThan(validationIdx);
    } else {
      // validation node was budget-filtered out — that's also correct behaviour
      expect(authIdx).toBeGreaterThan(-1);
    }
  });

  it("returns a clear message when no graph exists", async () => {
    // Remove the graph file so the store opens on an empty database
    const { rmSync: rm, existsSync } = await import("node:fs");
    const dbPath = join(testDir, ".dev-mem", "graph.sqlite");
    if (existsSync(dbPath)) rm(dbPath);

    const result = await runCli(["query", "some task"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No relevant context found");
  });

  it("returns usage error when no argument is given", async () => {
    const result = await runCli(["query"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: dev-mem query");
  });
});

describe("dev-mem inspect", () => {
  let testDir: string;
  let savedCwd: string;
  let nodeId: string;
  let nodeIdWithHistory: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "dev-mem-inspect-test-"));
    initGitRepo(testDir);
    savedCwd = process.cwd();
    process.chdir(testDir);

    const store = new GraphStore({ projectRoot: testDir });

    // Node that will remain in 'observed' — just creation history
    const node = store.createNode({
      type: "Decision",
      title: "Use in-memory Map for task storage in V1",
      content: "No persistence requirement; simplest option with zero dependencies.",
      evidence: {
        ...BASE_EVIDENCE,
        files: ["docs/architecture.md", "src/task-store.js"],
        diff_ref: "HEAD~1..HEAD",
        test_ref: "tests/task-store.test.js",
      },
    });
    nodeId = node.id;

    // Node that transitions: observed → active (two history entries)
    const node2 = store.createNode({
      type: "Constraint",
      title: "Provider-specific auth logic must stay behind AuthProvider abstraction",
      content: "Keeps coupling contained.",
      evidence: { ...BASE_EVIDENCE, files: ["src/auth/provider.ts"] },
    });
    store.transitionLifecycleState(node2.id, "active");
    nodeIdWithHistory = node2.id;

    // A third node with an edge to the first
    const node3 = store.createNode({
      type: "FailedApproach",
      title: "Direct SQLite — conflicts with in-memory architecture decision",
      content: "Rejected.",
      evidence: { ...BASE_EVIDENCE, files: ["src/store-sqlite.js"] },
    });
    store.createEdge({ from_id: node.id, to_id: node3.id, type: "contradicts" });

    store.close();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("prints all node fields for a valid id", async () => {
    const result = await runCli(["inspect", nodeId]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    // All core fields present
    expect(result.stdout).toContain(`id:              ${nodeId}`);
    expect(result.stdout).toContain("type:            Decision");
    expect(result.stdout).toContain("lifecycle_state: observed");
    expect(result.stdout).toContain("Use in-memory Map for task storage in V1");
    expect(result.stdout).toContain("No persistence requirement");
    expect(result.stdout).toContain("created_at:");
    expect(result.stdout).toContain("updated_at:");
  });

  it("prints all evidence fields including optional ones", async () => {
    const result = await runCli(["inspect", nodeId]);

    expect(result.stdout).toContain("evidence:");
    expect(result.stdout).toContain(`commit:     ${BASE_EVIDENCE.commit}`);
    expect(result.stdout).toContain("docs/architecture.md");
    expect(result.stdout).toContain("src/task-store.js");
    expect(result.stdout).toContain("diff_ref:   HEAD~1..HEAD");
    expect(result.stdout).toContain("test_ref:   tests/task-store.test.js");
    expect(result.stdout).toContain(`session_id: ${BASE_EVIDENCE.session_id}`);
    expect(result.stdout).toContain("agent:      claude-code");
    expect(result.stdout).toContain("confidence: 0.91");
  });

  it("shows lifecycle history with transition arrows", async () => {
    // Single-entry history (only creation)
    const result = await runCli(["inspect", nodeId]);
    expect(result.stdout).toContain("lifecycle_history:");
    expect(result.stdout).toContain("(created) → observed");
  });

  it("shows multi-step lifecycle history for a transitioned node", async () => {
    const result = await runCli(["inspect", nodeIdWithHistory]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(created) → observed");
    expect(result.stdout).toContain("observed → active");
  });

  it("shows edges when the node has them", async () => {
    const result = await runCli(["inspect", nodeId]);
    expect(result.stdout).toContain("edges:");
    expect(result.stdout).toContain("[contradicts]");
  });

  it("returns exit code 1 and a clear message for an unknown id", async () => {
    const result = await runCli(["inspect", "00000000-0000-0000-0000-000000000000"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Node not found");
    expect(result.stdout).toBe("");
  });

  it("returns usage error when no argument is given", async () => {
    const result = await runCli(["inspect"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: dev-mem inspect");
  });
});
