import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { EventLog } from "../core/capture/log.js";
import { getExtractionEventThreshold } from "../core/checkpoint.js";
import { acquireExtractionLock, markExtractionComplete } from "../core/extraction-lock.js";
import { GraphStore } from "../core/graph/index.js";

const projectRoot = process.cwd();

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "dev-mem-robustness-"));
}

function invoke(adapter: "claude-code" | "codex" | "cursor", payload: string, cwd: string) {
  return spawnSync(process.execPath, [join(projectRoot, "dist", "adapters", adapter, "hook.js")], {
    cwd,
    input: payload,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function invokeAsync(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("adapter robustness", () => {
  it.each([
    ["claude-code", "SessionStart"],
    ["codex", "SessionStart"],
    ["cursor", "sessionStart"],
  ] as const)("%s ignores truncated JSON and wrong base fields without crashing", (adapter, event) => {
    const dir = tempProject();
    try {
      for (const input of ["{\"session_id\":", JSON.stringify({ session_id: {}, cwd: [], hook_event_name: event })]) {
        const result = invoke(adapter, input, dir);
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("Ignoring");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("captures an out-of-order tool event but refuses an orphaned SessionEnd extraction", () => {
    const dir = tempProject();
    try {
      const tool = invoke("codex", JSON.stringify({
        session_id: "restarted", cwd: dir, hook_event_name: "PostToolUse", tool_name: "Bash",
        tool_input: { command: "npm test" }, tool_response: { exit_code: 0 }, extra: "ignored",
      }), dir);
      expect(tool.status).toBe(0);
      const end = invoke("codex", JSON.stringify({ session_id: "orphan", cwd: dir, hook_event_name: "SessionEnd" }), dir);
      expect(end.status).toBe(0);
      expect(end.stderr).toContain("without a prior SessionStart");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("survives corrupted local state and a reproducible write failure", () => {
    const dir = tempProject();
    try {
      mkdirSync(join(dir, ".dev-mem"), { recursive: true });
      writeFileSync(join(dir, ".dev-mem", "events.jsonl"), "{not json}\n");
      const corrupted = invoke("claude-code", JSON.stringify({ session_id: "broken", cwd: dir, hook_event_name: "SessionStart" }), dir);
      expect(corrupted.status).toBe(0);
      expect(corrupted.stderr).toContain("Hook error");

      rmSync(join(dir, ".dev-mem", "events.jsonl"));
      mkdirSync(join(dir, ".dev-mem", "events.jsonl")); // appendFileSync now fails like an unavailable full target
      const unavailable = invoke("cursor", JSON.stringify({ session_id: "write-fail", cwd: dir, hook_event_name: "sessionStart" }), dir);
      expect(unavailable.status).toBe(0);
      expect(unavailable.stderr).toContain("Hook error");

      rmSync(join(dir, ".dev-mem", "events.jsonl"), { recursive: true, force: true });
      writeFileSync(join(dir, ".dev-mem", "graph.sqlite"), "not a sqlite database");
      const badDatabase = invoke("codex", JSON.stringify({ session_id: "bad-db", cwd: dir, hook_event_name: "SessionStart" }), dir);
      expect(badDatabase.status).toBe(0);
      expect(badDatabase.stderr).toContain("Hook error");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("falls back from invalid Cursor checkpoint config and serializes duplicate extraction triggers", () => {
    const dir = tempProject();
    try {
      mkdirSync(join(dir, ".dev-mem"), { recursive: true });
      writeFileSync(join(dir, ".dev-mem", "config.yml"), "extraction_event_threshold: zero\n");
      expect(getExtractionEventThreshold(dir)).toBe(10);

      const release = acquireExtractionLock(dir, "same-session");
      expect(release).not.toBeNull();
      expect(acquireExtractionLock(dir, "same-session")).toBeNull();
      release?.();
      const again = acquireExtractionLock(dir, "same-session");
      expect(again).not.toBeNull();
      again?.();
      markExtractionComplete(dir, "same-session");
      expect(acquireExtractionLock(dir, "same-session")).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses SQLite WAL/busy handling safely across two graph connections", () => {
    const dir = tempProject();
    let first: GraphStore | undefined;
    let second: GraphStore | undefined;
    try {
      first = new GraphStore({ projectRoot: dir });
      second = new GraphStore({ projectRoot: dir });
      first.createNode({ type: "Decision", title: "first writer", evidence: { commit: "a", files: ["a.ts"], session_id: "a", agent: "claude-code", timestamp: new Date().toISOString(), confidence: 1 } });
      second.createNode({ type: "Discovery", title: "second writer", evidence: { commit: "b", files: ["b.ts"], session_id: "b", agent: "cursor", timestamp: new Date().toISOString(), confidence: 1 } });
      expect(first.queryAllNodes()).toHaveLength(2);
    } finally {
      first?.close(); second?.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows only one concurrent CLI extraction for the same Cursor checkpoint session", async () => {
    const dir = tempProject();
    try {
      const started = invoke("cursor", JSON.stringify({ session_id: "checkpoint", cwd: dir, hook_event_name: "sessionStart" }), dir);
      expect(started.status).toBe(0);
      const cli = join(projectRoot, "dist", "cli", "index.js");
      const env = { ...process.env, DEV_MEM_MOCK_LLM: "1" };
      const [first, second] = await Promise.all([
        invokeAsync(process.execPath, [cli, "extract", "checkpoint"], dir, env),
        invokeAsync(process.execPath, [cli, "extract", "checkpoint"], dir, env),
      ]);
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect([first.stdout, second.stdout].join("\n")).toContain("Extraction skipped");
      const store = new GraphStore({ projectRoot: dir });
      expect(store.queryAllNodes()).toHaveLength(2);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports a corrupt event log rather than silently accepting it", () => {
    const dir = tempProject();
    try {
      const path = join(dir, "events.jsonl");
      writeFileSync(path, "not-json\n");
      expect(() => new EventLog({ persistPath: path })).toThrow("Corrupt event log at line 1");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
