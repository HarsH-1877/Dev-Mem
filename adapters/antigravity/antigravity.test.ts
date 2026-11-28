import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../../core/graph/index.js";

describe("Antigravity CLI adapter hook", () => {
  let dir: string;
  const hookJs = join(process.cwd(), "dist", "adapters", "antigravity", "hook.js");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-agy-adapter-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@dev-mem.test"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# Test\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Ignore transient Windows file lock cleanup issues
    }
  });

  it("handles SessionStart with camelCase conversationId/workspacePaths and outputs additionalContext", () => {
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "Decision",
      title: "Use SQLite WAL mode for concurrent Antigravity hooks",
      content: "WAL avoids SQLITE_BUSY errors",
      lifecycle_state: "verified",
      evidence: {
        commit: "1111111111111111111111111111111111111111",
        files: ["README.md"],
        session_id: "prior-s",
        agent: "antigravity",
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      },
    });
    store.close();

    const payload = {
      conversationId: "conv-agy-1",
      workspacePaths: [dir],
      hook_event_name: "SessionStart",
    };
    const res = spawnSync(process.execPath, [hookJs], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf8",
    });

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.additionalContext).toContain("SQLite WAL mode");

    const eventsRaw = readFileSync(join(dir, ".dev-mem", "events.jsonl"), "utf8");
    const events = eventsRaw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === "session_start" && e.session_id === "conv-agy-1" && e.agent === "antigravity")).toBe(true);
  });

  it("handles PreInvocation prompt-time retrieval with minRelevance 0.08 and deduplicates per session", () => {
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "Decision",
      title: "JWT token refresh must serialize concurrent refresh calls",
      content: "Single-flight refresh prevents rotation race conditions in auth middleware",
      lifecycle_state: "verified",
      evidence: {
        commit: "2222222222222222222222222222222222222222",
        files: ["src/auth/jwt.ts"],
        session_id: "prior-jwt",
        agent: "antigravity",
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      },
    });
    store.createNode({
      type: "Discovery",
      title: "PostgreSQL autovacuum threshold tuned for analytics ledger",
      content: "Lowered vacuum scale factor to 0.02 for large append-only tables",
      lifecycle_state: "verified",
      evidence: {
        commit: "3333333333333333333333333333333333333333",
        files: ["db/migrations/001.sql"],
        session_id: "prior-pg",
        agent: "antigravity",
        timestamp: new Date().toISOString(),
        confidence: 0.99,
      },
    });
    store.close();

    const first = spawnSync(process.execPath, [hookJs, "--event", "PreInvocation"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-preinv",
        workspacePaths: [dir],
        prompt: "Fix JWT token refresh race condition in auth middleware",
        stepIdx: 1,
      }),
      encoding: "utf8",
    });

    expect(first.status).toBe(0);
    const firstOut = JSON.parse(first.stdout);
    expect(firstOut.additionalContext).toContain("JWT token refresh");
    expect(firstOut.additionalContext).not.toContain("PostgreSQL autovacuum");

    // Second invocation in the same session should deduplicate already-seen nodes
    const second = spawnSync(process.execPath, [hookJs, "--event", "PreInvocation"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-preinv",
        workspacePaths: [dir],
        message: "Fix JWT token refresh race condition in auth middleware",
        stepIdx: 2,
      }),
      encoding: "utf8",
    });

    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe("");
  });

  it("handles PreToolUse safely, records exit_code -1, always prints decision=allow, and warns on FailedApproach overlap", () => {
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "FailedApproach",
      title: "Modifying src/auth.ts without CSRF validation broke login",
      content: "Always check token origin",
      lifecycle_state: "active",
      evidence: {
        commit: "1111111111111111111111111111111111111111",
        files: ["src/auth.ts"],
        session_id: "prior-s",
        agent: "antigravity",
        timestamp: new Date().toISOString(),
        confidence: 0.9,
      },
    });
    store.close();

    const matched = spawnSync(process.execPath, [hookJs, "--event", "PreToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-2",
        workspacePaths: [dir],
        toolCall: {
          name: "replace_file_content",
          args: { TargetFile: "src/auth.ts", ReplacementContent: "login()" },
        },
      }),
      encoding: "utf8",
    });

    expect(matched.status).toBe(0);
    const out = JSON.parse(matched.stdout);
    expect(out.decision).toBe("allow");
    expect(out.additionalContext).toContain("Regression Intelligence");

    // Unrelated file/tool mutation should still output decision=allow without warning
    const unmatched = spawnSync(process.execPath, [hookJs, "--event", "PreToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-2",
        workspacePaths: [dir],
        tool_call: {
          name: "write_to_file",
          args: { TargetFile: "src/unrelated.ts", CodeContent: "export const ok = true;" },
        },
      }),
      encoding: "utf8",
    });

    expect(unmatched.status).toBe(0);
    const unmatchedOut = JSON.parse(unmatched.stdout);
    expect(unmatchedOut.decision).toBe("allow");
    expect(unmatchedOut.additionalContext).toBeUndefined();

    const eventsRaw = readFileSync(join(dir, ".dev-mem", "events.jsonl"), "utf8");
    const toolEvents = eventsRaw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === "tool_call");
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0].exit_code).toBe(-1);
    expect(toolEvents[0].command).toBe("replace_file_content");
    expect(toolEvents[0].args).toEqual(["src/auth.ts"]);
    expect(toolEvents[0].agent).toBe("antigravity");
    expect(toolEvents[1].exit_code).toBe(-1);
    expect(toolEvents[1].command).toBe("write_to_file");
    expect(toolEvents[1].args).toEqual(["src/unrelated.ts"]);
  });

  it("handles PostToolUse recording and deduplicates repeated regression warnings across PreToolUse/PostToolUse", () => {
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "FailedApproach",
      title: "Editing src/billing.ts directly caused rounding drift",
      content: "Use decimal helper instead of float arithmetic",
      lifecycle_state: "active",
      evidence: {
        commit: "4444444444444444444444444444444444444444",
        files: ["src/billing.ts"],
        session_id: "prior-billing",
        agent: "antigravity",
        timestamp: new Date().toISOString(),
        confidence: 0.92,
      },
    });
    store.close();

    // PreToolUse on src/billing.ts emits warning once with decision=allow
    const preTool = spawnSync(process.execPath, [hookJs, "--event", "PreToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-post",
        workspacePaths: [dir],
        toolCall: {
          name: "replace_file_content",
          args: { TargetFile: "src/billing.ts", ReplacementContent: "total * 1.05" },
        },
      }),
      encoding: "utf8",
    });

    expect(preTool.status).toBe(0);
    const preOut = JSON.parse(preTool.stdout);
    expect(preOut.decision).toBe("allow");
    expect(preOut.additionalContext).toContain("Regression Intelligence");

    // Subsequent PostToolUse for the same session & file suppresses duplicate warning
    const firstPost = spawnSync(process.execPath, [hookJs, "--event", "PostToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-post",
        workspacePaths: [dir],
        toolCall: {
          name: "multi_replace_file_content",
          args: { TargetFile: "src/billing.ts", ReplacementChunks: [{ ReplacementContent: "total * 1.1" }] },
        },
        exitCode: 0,
      }),
      encoding: "utf8",
    });

    expect(firstPost.status).toBe(0);
    expect(firstPost.stdout.trim()).toBe("");

    // Shell command tool recording
    const shellPost = spawnSync(process.execPath, [hookJs, "--event", "PostToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-post",
        workspacePaths: [dir],
        toolCall: {
          name: "run_command",
          args: { CommandLine: "npm test" },
        },
        toolOutput: { stdout: "all passed", stderr: "", exitCode: 0 },
      }),
      encoding: "utf8",
    });
    expect(shellPost.status).toBe(0);

    const eventsRaw = readFileSync(join(dir, ".dev-mem", "events.jsonl"), "utf8");
    const toolEvents = eventsRaw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === "tool_call");
    expect(toolEvents).toHaveLength(3);
    expect(toolEvents[0].exit_code).toBe(-1);
    expect(toolEvents[1].exit_code).toBe(0);
    expect(toolEvents[1].args).toEqual(["src/billing.ts"]);
    expect(toolEvents[2].command).toBe("npm test");
    expect(toolEvents[2].stdout).toBe("all passed");
  });

  it("handles Stop cleanly by recording session_end", () => {
    const startRes = spawnSync(process.execPath, [hookJs, "--event", "SessionStart"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-stop",
        workspacePaths: [dir],
      }),
      encoding: "utf8",
    });
    expect(startRes.status).toBe(0);

    const stopRes = spawnSync(process.execPath, [hookJs, "--event", "Stop"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-stop",
        workspacePaths: [dir],
      }),
      env: { ...process.env, DEV_MEM_MOCK_LLM: "1" },
      encoding: "utf8",
    });
    expect(stopRes.status).toBe(0);

    const eventsRaw = readFileSync(join(dir, ".dev-mem", "events.jsonl"), "utf8");
    const events = eventsRaw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(events.some((e) => e.type === "session_end" && e.session_id === "conv-agy-stop")).toBe(true);

    // Orphaned Stop without prior SessionStart still records session_end and skips extraction cleanly
    const orphanStop = spawnSync(process.execPath, [hookJs, "--event", "Stop"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-orphan",
        workspacePaths: [dir],
      }),
      encoding: "utf8",
    });
    expect(orphanStop.status).toBe(0);
    expect(orphanStop.stderr).toContain("without a prior SessionStart");
  });

  it("exits cleanly with no side effects when DEV_MEM_DISABLE_HOOKS=1 and fails open on malformed JSON", () => {
    const disabledRes = spawnSync(process.execPath, [hookJs, "--event", "SessionStart"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-disabled",
        workspacePaths: [dir],
      }),
      env: { ...process.env, DEV_MEM_DISABLE_HOOKS: "1" },
      encoding: "utf8",
    });
    expect(disabledRes.status).toBe(0);
    expect(disabledRes.stdout.trim()).toBe("");
    expect(existsSync(join(dir, ".dev-mem"))).toBe(false);

    // Malformed JSON on non-PreToolUse fails open cleanly with exit 0
    const badStart = spawnSync(process.execPath, [hookJs, "--event", "SessionStart"], {
      cwd: dir,
      input: "{malformed-json",
      encoding: "utf8",
    });
    expect(badStart.status).toBe(0);
    expect(badStart.stderr).toContain("Ignoring");

    // Malformed JSON on PreToolUse MUST still print {"decision":"allow"} and exit 0
    const badPreTool = spawnSync(process.execPath, [hookJs, "--event", "PreToolUse"], {
      cwd: dir,
      input: "{malformed-json",
      encoding: "utf8",
    });
    expect(badPreTool.status).toBe(0);
    expect(JSON.parse(badPreTool.stdout)).toEqual({ decision: "allow" });

    // Missing conversationId/session_id on PreToolUse WITHOUT --event MUST still emit {"decision":"allow"}
    const missingConvPreTool = spawnSync(process.execPath, [hookJs], {
      cwd: dir,
      input: JSON.stringify({ hook_event_name: "PreToolUse", workspacePaths: [dir] }),
      encoding: "utf8",
    });
    expect(missingConvPreTool.status).toBe(0);
    expect(JSON.parse(missingConvPreTool.stdout)).toEqual({ decision: "allow" });
  });

  it("relativizes absolute TargetFile/AbsolutePath paths, handles view_file/Write/Edit aliases, and accepts PostInvocation", () => {
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "FailedApproach",
      title: "Mutating src/auth.ts directly broke session cookies",
      content: "Use cookie helper",
      lifecycle_state: "active",
      evidence: {
        commit: "5555555555555555555555555555555555555555",
        files: ["src/auth.ts"],
        session_id: "prior-rel",
        agent: "antigravity",
        timestamp: new Date().toISOString(),
        confidence: 0.9,
      },
    });
    store.close();

    // Absolute TargetFile should be relativized to "src/auth.ts" and trigger Regression Intelligence
    const absTarget = spawnSync(process.execPath, [hookJs, "--event", "PreToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-paths",
        workspacePaths: [dir],
        toolCall: {
          name: "replace_file_content",
          args: { TargetFile: join(dir, "src", "auth.ts"), ReplacementContent: "setCookie()" },
        },
      }),
      encoding: "utf8",
    });
    expect(absTarget.status).toBe(0);
    const absOut = JSON.parse(absTarget.stdout);
    expect(absOut.decision).toBe("allow");
    expect(absOut.additionalContext).toContain("Regression Intelligence");

    // view_file with AbsolutePath
    const viewRes = spawnSync(process.execPath, [hookJs, "--event", "PostToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-paths",
        workspacePaths: [dir],
        toolCall: {
          name: "view_file",
          args: { AbsolutePath: join(dir, "src", "view.ts") },
        },
        exitCode: 0,
      }),
      encoding: "utf8",
    });
    expect(viewRes.status).toBe(0);

    // Fallback aliases: Write with file_path, Edit with path
    const writeAlias = spawnSync(process.execPath, [hookJs, "--event", "PostToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-paths",
        workspacePaths: [dir],
        toolCall: {
          name: "Write",
          args: { file_path: "./src/written.ts", content: "export const a = 1;" },
        },
        exitCode: 0,
      }),
      encoding: "utf8",
    });
    expect(writeAlias.status).toBe(0);

    const editAlias = spawnSync(process.execPath, [hookJs, "--event", "PostToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-paths",
        workspacePaths: [dir],
        toolCall: {
          name: "Edit",
          args: { path: "src\\edited.ts", new_string: "export const b = 2;" },
        },
        exitCode: 0,
      }),
      encoding: "utf8",
    });
    expect(editAlias.status).toBe(0);

    // PostInvocation is accepted cleanly as a no-op
    const postInv = spawnSync(process.execPath, [hookJs, "--event", "PostInvocation"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-paths",
        workspacePaths: [dir],
      }),
      encoding: "utf8",
    });
    expect(postInv.status).toBe(0);
    expect(postInv.stdout.trim()).toBe("");

    const eventsRaw = readFileSync(join(dir, ".dev-mem", "events.jsonl"), "utf8");
    const toolEvents = eventsRaw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === "tool_call");
    expect(toolEvents).toHaveLength(4);
    expect(toolEvents[0].args).toEqual(["src/auth.ts"]);
    expect(toolEvents[1].command).toBe("view_file");
    expect(toolEvents[1].args).toEqual(["src/view.ts"]);
    expect(toolEvents[2].command).toBe("Write");
    expect(toolEvents[2].args).toEqual(["src/written.ts"]);
    expect(toolEvents[3].command).toBe("Edit");
    expect(toolEvents[3].args).toEqual(["src/edited.ts"]);
  });
});
