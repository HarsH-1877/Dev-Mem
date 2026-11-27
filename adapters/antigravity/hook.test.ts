import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { GraphStore } from "../../core/graph/index.js";
import { EventLog } from "../../core/capture/log.js";

const projectRoot = process.cwd();
const hookPath = join(projectRoot, "dist", "adapters", "antigravity", "hook.js");
const cliPath = join(projectRoot, "dist", "cli", "index.js");

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "dev-mem-antigravity-"));
}

function invokeHook(payload: unknown, cwd: string) {
  return spawnSync(process.execPath, [hookPath], {
    cwd,
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("antigravity adapter", () => {
  it("records SessionStart and injects relevant graph context via injectSteps", () => {
    const dir = tempProject();
    try {
      const store = new GraphStore({ projectRoot: dir });
      store.createNode({
        type: "Decision",
        title: "Use PostgreSQL for primary storage",
        detail: "Avoid SQLite in multi-worker production.",
        evidence: {
          commit: "abc123",
          files: ["src/db.ts"],
          session_id: "prior-sess",
          agent: "claude-code",
          timestamp: new Date().toISOString(),
          confidence: 0.95,
        },
      });
      store.close();

      const res = invokeHook(
        {
          conversationId: "ag-sess-1",
          hookEventName: "SessionStart",
          cwd: dir,
          lastUserInput: "Update PostgreSQL storage layer in src/db.ts",
        },
        dir,
      );

      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout.trim());
      expect(Array.isArray(out.injectSteps)).toBe(true);
      expect(out.injectSteps[0]?.systemMessage?.systemMessage).toContain("Use PostgreSQL for primary storage");

      const events = new EventLog({ persistPath: join(dir, ".dev-mem", "events.jsonl") }).getEvents();
      expect(events.some((e) => e.type === "session_start" && e.agent === "antigravity" && e.session_id === "ag-sess-1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles PreToolUse, PostToolUse (success & error), and Stop lifecycle events", () => {
    const dir = tempProject();
    try {
      const store = new GraphStore({ projectRoot: dir });
      store.createNode({
        type: "FailedApproach",
        title: "Do not use sync fs in src/server.ts",
        detail: "Blocks the event loop under load.",
        evidence: {
          commit: "def456",
          files: ["src/server.ts"],
          session_id: "prior-sess",
          agent: "codex",
          timestamp: new Date().toISOString(),
          confidence: 0.9,
        },
      });
      store.close();

      const start = invokeHook(
        { conversationId: "ag-sess-2", hookEventName: "SessionStart", cwd: dir },
        dir,
      );
      expect(start.status).toBe(0);

      const pre = invokeHook(
        {
          conversationId: "ag-sess-2",
          hookEventName: "PreToolUse",
          cwd: dir,
          toolCall: { id: "t1", name: "replace_file_content", args: { TargetFile: "src/server.ts" } },
        },
        dir,
      );
      expect(pre.status).toBe(0);
      const preOut = JSON.parse(pre.stdout.trim());
      expect(preOut.decision).toBe("allow");
      expect(preOut.reason).toContain("Do not use sync fs in src/server.ts");

      const postOk = invokeHook(
        {
          conversationId: "ag-sess-2",
          hookEventName: "PostToolUse",
          cwd: dir,
          toolCall: { id: "t2", name: "run_command", args: { CommandLine: "npm test" } },
        },
        dir,
      );
      expect(postOk.status).toBe(0);
      expect(JSON.parse(postOk.stdout.trim())).toEqual({});

      const postErr = invokeHook(
        {
          conversationId: "ag-sess-2",
          hookEventName: "PostToolUse",
          cwd: dir,
          toolCall: { id: "t3", name: "run_command", args: { CommandLine: "npm run build" } },
          error: "exit status 1",
        },
        dir,
      );
      expect(postErr.status).toBe(0);
      expect(JSON.parse(postErr.stdout.trim())).toEqual({});

      const stop = invokeHook(
        {
          conversationId: "ag-sess-2",
          hookEventName: "Stop",
          cwd: dir,
          terminationReason: "NO_TOOL_CALL",
        },
        dir,
      );
      expect(stop.status).toBe(0);
      expect(JSON.parse(stop.stdout.trim())).toEqual({});

      const events = new EventLog({ persistPath: join(dir, ".dev-mem", "events.jsonl") }).getEvents();
      const toolCalls = events.filter((e) => e.type === "tool_call");
      expect(toolCalls.length).toBe(3);
      expect(toolCalls[0]).toMatchObject({ command: "replace_file_content", args: ["src/server.ts"], exit_code: -1 });
      expect(toolCalls[1]).toMatchObject({ command: "npm test", exit_code: 0 });
      expect(toolCalls[2]).toMatchObject({ command: "npm run build", exit_code: 1, stderr: "exit status 1" });
      expect(events.some((e) => e.type === "session_end" && e.session_id === "ag-sess-2")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs and uninstalls Antigravity hooks without clobbering existing hooks.json entries", () => {
    const dir = tempProject();
    try {
      mkdirSync(join(dir, ".agents"), { recursive: true });
      writeFileSync(
        join(dir, ".agents", "hooks.json"),
        JSON.stringify({ "custom-lint": { PostToolUse: [] } }, null, 2),
        "utf8",
      );

      const installRes = spawnSync(process.execPath, [cliPath, "install", "antigravity"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(installRes.status).toBe(0);
      expect(installRes.stdout).toContain("antigravity");

      const hooksJson = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"));
      expect(hooksJson["custom-lint"]).toEqual({ PostToolUse: [] });
      expect(hooksJson["dev-mem"]).toBeDefined();
      expect(hooksJson["dev-mem"].SessionStart[0].command).toBe("node ./hooks/dev-mem-session-start.js");
      expect(existsSync(join(dir, ".agents", "hooks", "dev-mem-session-start.js"))).toBe(true);
      expect(existsSync(join(dir, ".agents", "hooks", "dev-mem-stop.js"))).toBe(true);

      const uninstallRes = spawnSync(process.execPath, [cliPath, "uninstall"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(uninstallRes.status).toBe(0);

      const afterHooksJson = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"));
      expect(afterHooksJson["custom-lint"]).toEqual({ PostToolUse: [] });
      expect(afterHooksJson["dev-mem"]).toBeUndefined();
      expect(existsSync(join(dir, ".agents", "hooks", "dev-mem-session-start.js"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
