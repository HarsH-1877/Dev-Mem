/**
 * Tests for dev-mem query and dev-mem inspect CLI commands.
 *
 * Uses a real GraphStore (in-memory) and runs the commands through runCli()
 * so the full code path is exercised — not just that the command doesn't crash.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { GraphStore } from "../core/graph/index.js";
import { runCli, findStaleHooks, runDoctor, runPrune, runSync } from "./index.js";
import { markExtractionComplete } from "../core/extraction-lock.js";
import { EventLog } from "../core/capture/log.js";

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
    expect(result.stderr).toContain("Usage: dev-memo query");
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
    expect(result.stderr).toContain("Usage: dev-memo inspect");
  });
});

describe("dev-memo top-level flags and failure reporting", () => {
  let testDir: string;
  let savedCwd: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "dev-mem-cli-flags-"));
    initGitRepo(testDir);
    savedCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it("prints the package version for --version and -v", async () => {
    const pkg = JSON.parse(readFileSync(join(savedCwd, "package.json"), "utf8"));
    for (const flag of ["--version", "-v"]) {
      const result = await runCli([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(pkg.version);
    }
  });

  it("prints usage with exit code 0 for --help and -h", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: dev-memo");
      expect(result.stdout).toContain("install");
    }
  });

  it("does not report success when extraction fails", async () => {
    const result = await runCli(["extract", "no-such-session"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("Extraction complete");
    expect(result.stderr).toContain("Extraction failed");
  });
});

describe("stale hook detection", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dm-stale-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("flags v1 hooks that embed an absolute path", () => {
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hooks", "dev-mem-sessionstart.js"),
      'import { pathToFileURL } from "node:url";\nawait import(pathToFileURL("C:/x/dist/adapters/claude-code/hook.js").href);\n');
    expect(findStaleHooks(dir)).toEqual([".claude/hooks/dev-mem-sessionstart.js"]);
  });

  it("flags v1 OpenCode .ts plugins that lack the hook marker", () => {
    mkdirSync(join(dir, ".opencode", "plugins"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "plugins", "dev-mem.ts"), "// old opencode plugin\n");
    expect(findStaleHooks(dir)).toEqual([".opencode/plugins/dev-mem.ts"]);
  });

  it("does not flag freshly installed hooks", async () => {
    initGitRepo(dir);
    await runCli(["install", "claude-code"], { cwd: dir });
    expect(findStaleHooks(dir)).toEqual([]);
  });

  it("status prints an upgrade warning when stale hooks exist", async () => {
    initGitRepo(dir);
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".claude", "hooks", "dev-mem-stop.js"), "// old\n");
    const res = await runCli(["status"], { cwd: dir });
    expect(res.stdout + res.stderr).toContain("Run `dev-memo install` to upgrade");
  });
});

describe("dev-memo doctor", () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dm-doc-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.env = { ...saved }; });

  it("fails outside a git repo", async () => {
    const r = await runDoctor(dir);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("✗ Not a git repository");
  });

  it("fails when no LLM provider is configured", async () => {
    initGitRepo(dir);
    for (const k of ["ANTHROPIC_API_KEY","OPENAI_API_KEY","GEMINI_API_KEY","GOOGLE_API_KEY","DEV_MEM_LLM_BASE_URL","DEV_MEM_LLM_PROVIDER","DEV_MEM_LLM_API_KEY"]) delete process.env[k];
    const r = await runDoctor(dir);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toContain("✗ No LLM provider configured");
  });

  it("passes with hooks installed and a provider set", async () => {
    initGitRepo(dir);
    process.env.GEMINI_API_KEY = "test-key";
    process.env.DEV_MEM_DIST_DIR = join(process.cwd(), "dist");
    await runCli(["install", "claude-code"], { cwd: dir });
    const r = await runDoctor(dir);
    expect(r.lines.join("\n")).toContain("✓ LLM provider: gemini");
    expect(r.lines.join("\n")).toContain("✓ Hooks up to date");
    expect(r.ok).toBe(true);
  });

  it("routes doctor command through runCli", async () => {
    initGitRepo(dir);
    process.env.GEMINI_API_KEY = "test-key";
    process.env.DEV_MEM_DIST_DIR = join(process.cwd(), "dist");
    await runCli(["install", "claude-code"], { cwd: dir });
    const r = await runCli(["doctor"], { cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("✓ LLM provider: gemini");
  });
});

describe("dev-memo prune", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-cli-prune-"));
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prunes events for completed extractions via runCli", async () => {
    const logPath = join(dir, ".dev-mem", "events.jsonl");
    const log = new EventLog({ persistPath: logPath });
    log.append({ type: "session_start", id: "1", timestamp: "t1", session_id: "done-sess", agent: "claude-code", project_root: dir });
    log.append({ type: "session_start", id: "2", timestamp: "t2", session_id: "active-sess", agent: "claude-code", project_root: dir });

    markExtractionComplete(dir, "done-sess");

    const res = await runCli(["prune"], { cwd: dir });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("Pruned 1 extracted event(s); 1 active event(s) kept.\n");

    const reloaded = new EventLog({ persistPath: logPath }).getEvents();
    expect(reloaded.map((e) => e.session_id)).toEqual(["active-sess"]);
  });

  it("exports runPrune function", () => {
    const logPath = join(dir, ".dev-mem", "events.jsonl");
    const log = new EventLog({ persistPath: logPath });
    log.append({ type: "session_start", id: "1", timestamp: "t1", session_id: "done-sess", agent: "claude-code", project_root: dir });

    markExtractionComplete(dir, "done-sess");

    const result = runPrune(dir);
    expect(result).toEqual({ removedEvents: 1, keptEvents: 0 });
  });

  it("includes prune in help text", async () => {
    const res = await runCli(["--help"]);
    expect(res.stdout).toContain("prune");
    expect(res.stdout).toContain("Remove events from already-extracted sessions");
  });

  it("includes mcp in help text", async () => {
    const res = await runCli(["--help"]);
    expect(res.stdout).toContain("mcp");
    expect(res.stdout).toContain("Run the stdio Model Context Protocol (MCP) server");
  });
});

describe("dev-memo sync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-cli-sync-"));
    initGitRepo(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("syncs graph via runCli and formats output", async () => {
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "Decision",
      title: "Use ESM modules",
      content: "All source files are ESM",
      lifecycle_state: "active",
      evidence: { ...BASE_EVIDENCE, files: ["package.json"] },
    });
    store.close();

    const res = await runCli(["sync"], { cwd: dir });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("Synced .dev-mem/shared.jsonl (imported: 0, updated: 0, exported: 1 active/verified nodes).\n");

    const sharedContent = readFileSync(join(dir, ".dev-mem", "shared.jsonl"), "utf8");
    expect(sharedContent).toContain("Use ESM modules");
  });

  it("exports runSync function", () => {
    const result = runSync(dir);
    expect(result).toEqual({ importedNodes: 0, updatedNodes: 0, exportedNodes: 0 });
  });

  it("includes sync in help text", async () => {
    const res = await runCli(["--help"]);
    expect(res.stdout).toContain("sync");
    expect(res.stdout).toContain("Sync active/verified nodes with git-friendly .dev-mem/shared.jsonl");
  });
});