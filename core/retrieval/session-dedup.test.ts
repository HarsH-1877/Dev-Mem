import { describe, it, expect } from "vitest";
import { filterUnseenNodes } from "./session-dedup.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { GraphStore } from "../graph/index.js";
import { runCli } from "../../cli/index.js";

const rootDir = process.cwd();

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@dev-mem.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("Per-session node injection deduplication", () => {
  it("returns only nodes not yet injected in the same session", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-dedup-"));
    try {
      const batch1 = filterUnseenNodes(dir, "sess-1", [{ id: "n1" }, { id: "n2" }]);
      expect(batch1.map((n) => n.id)).toEqual(["n1", "n2"]);

      const batch2 = filterUnseenNodes(dir, "sess-1", [{ id: "n2" }, { id: "n3" }]);
      expect(batch2.map((n) => n.id)).toEqual(["n3"]);

      // Different session sees all nodes fresh
      const batchOther = filterUnseenNodes(dir, "sess-2", [{ id: "n1" }]);
      expect(batchOther.map((n) => n.id)).toEqual(["n1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists seen node IDs into .dev-mem/sessions/<session-id>.injected.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-dedup-"));
    try {
      filterUnseenNodes(dir, "sess-persist", [{ id: "node-a" }, { id: "node-b" }]);
      const dedupFile = join(dir, ".dev-mem", "sessions", "sess-persist.injected.json");
      expect(existsSync(dedupFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(dedupFile, "utf8"));
      expect(parsed).toEqual(["node-a", "node-b"]);

      // Subsequent call adds new node
      filterUnseenNodes(dir, "sess-persist", [{ id: "node-b" }, { id: "node-c" }]);
      const updated = JSON.parse(readFileSync(dedupFile, "utf8"));
      expect(updated).toEqual(["node-a", "node-b", "node-c"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles empty sessionId or empty nodes gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-dedup-"));
    try {
      expect(filterUnseenNodes(dir, "", [{ id: "n1" }])).toEqual([{ id: "n1" }]);
      expect(filterUnseenNodes(dir, "sess-1", [])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles corrupted injected.json gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-dedup-"));
    try {
      const sessionsDir = join(dir, ".dev-mem", "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "sess-corrupted.injected.json"), "invalid-json", "utf8");

      const result = filterUnseenNodes(dir, "sess-corrupted", [{ id: "n1" }]);
      expect(result.map((n) => n.id)).toEqual(["n1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude Code UserPromptSubmit and OpenCode prompt-time injection with deduplication", () => {
  it("injects context on UserPromptSubmit and deduplicates on subsequent prompts", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-hook-prompt-"));
    initGitRepo(dir);
    try {
      const store = new GraphStore({ projectRoot: dir });
      store.createNode({
        type: "Decision",
        title: "Use Redis for fast session caching",
        content: "Redis cache stores active user sessions with 15-minute TTL.",
        evidence: {
          commit: "abc1234def5678901234567890abcdef12345678",
          files: ["src/cache/redis.ts"],
          session_id: "s-init",
          agent: "claude-code",
          timestamp: new Date().toISOString(),
          confidence: 0.95,
        },
      });
      store.close();

      const hookScript = join(rootDir, "dist", "adapters", "claude-code", "hook.js");

      // First prompt: should retrieve and inject Redis decision
      const run1 = spawnSync(process.execPath, [hookScript], {
        cwd: dir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-prompt-test",
          cwd: dir,
          prompt: "How do we implement Redis fast session caching?",
        }),
        encoding: "utf8",
      });

      expect(run1.status).toBe(0);
      expect(run1.stdout).toContain("Redis");
      const out1 = JSON.parse(run1.stdout.trim());
      expect(out1.hookSpecificOutput.additionalContext).toContain("Use Redis for fast session caching");

      // Second prompt in same session with same query: should be deduplicated (no additional context)
      const run2 = spawnSync(process.execPath, [hookScript], {
        cwd: dir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-prompt-test",
          cwd: dir,
          prompt: "How do we implement Redis fast session caching?",
        }),
        encoding: "utf8",
      });

      expect(run2.status).toBe(0);
      expect(run2.stdout.trim()).toBe("");

      // Blank prompt: outputs nothing
      const runBlank = spawnSync(process.execPath, [hookScript], {
        cwd: dir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "sess-prompt-test",
          cwd: dir,
          prompt: "   ",
        }),
        encoding: "utf8",
      });

      expect(runBlank.status).toBe(0);
      expect(runBlank.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles OpenCode chat.message prompt relevance and deduplication", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-opencode-prompt-"));
    initGitRepo(dir);
    try {
      const store = new GraphStore({ projectRoot: dir });
      store.createNode({
        type: "Decision",
        title: "Use PostgreSQL for durable relational storage",
        content: "PostgreSQL with connection pooling stores primary relational entities.",
        evidence: {
          commit: "abc1234def5678901234567890abcdef12345678",
          files: ["src/db/postgres.ts"],
          session_id: "s-opencode-init",
          agent: "opencode",
          timestamp: new Date().toISOString(),
          confidence: 0.95,
        },
      });
      store.close();

      const hookScript = join(rootDir, "dist", "adapters", "opencode", "hook.js");

      // First chat.message: should inject PostgreSQL decision
      const run1 = spawnSync(process.execPath, [hookScript], {
        cwd: dir,
        input: JSON.stringify({
          hook_event_name: "chat.message",
          session_id: "sess-opencode-test",
          cwd: dir,
          message: "Please configure PostgreSQL relational storage",
        }),
        encoding: "utf8",
      });

      expect(run1.status).toBe(0);
      const out1 = JSON.parse(run1.stdout.trim());
      expect(out1.hookSpecificOutput.additionalContext).toContain("Use PostgreSQL for durable relational storage");

      // Second chat.message with same session: deduplicated
      const run2 = spawnSync(process.execPath, [hookScript], {
        cwd: dir,
        input: JSON.stringify({
          hook_event_name: "chat.message",
          session_id: "sess-opencode-test",
          cwd: dir,
          message: "Please configure PostgreSQL relational storage",
        }),
        encoding: "utf8",
      });

      expect(run2.status).toBe(0);
      expect(run2.stdout.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers and unregisters UserPromptSubmit hook during claude-code install/uninstall", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-claude-install-"));
    initGitRepo(dir);
    try {
      await runCli(["install", "claude-code"], { cwd: dir });

      const hookFile = join(dir, ".claude", "hooks", "dev-mem-userpromptsubmit.js");
      expect(existsSync(hookFile)).toBe(true);

      const settingsFile = join(dir, ".claude", "settings.json");
      expect(existsSync(settingsFile)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      expect(settings.hooks.UserPromptSubmit[0].hooks[0].args[0]).toContain("dev-mem-userpromptsubmit.js");

      await runCli(["uninstall"], { cwd: dir });

      expect(existsSync(hookFile)).toBe(false);
      const uninstalledSettings = JSON.parse(readFileSync(settingsFile, "utf8"));
      expect(uninstalledSettings.hooks.UserPromptSubmit).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
