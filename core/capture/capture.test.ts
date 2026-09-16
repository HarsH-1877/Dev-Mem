import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeterministicCapture } from "./index.js";
import type { CaptureEvent } from "./events.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initSampleRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "dev-mem-capture-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "dev-mem@test.local"]);
  git(root, ["config", "user.name", "Dev Mem Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

function typesOf(events: CaptureEvent[]): CaptureEvent["type"][] {
  return events.map((event) => event.type);
}

describe("DeterministicCapture", () => {
  it("logs a sequence of git changes, file touches, and commands", () => {
    const root = initSampleRepo();
    writeFileSync(join(root, "README.md"), "# sample\n", "utf8");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "Initial commit"]);

    const capture = new DeterministicCapture({
      projectRoot: root,
      agent: "claude-code",
      sessionId: "sess_test",
      ephemeral: true,
    });

    capture.startSession();
    const firstSnap = capture.captureGit();
    expect(firstSnap.branch).toBe("main");
    expect(firstSnap.head_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(firstSnap.recent_commits[0]?.subject).toBe("Initial commit");

    writeFileSync(join(root, "app.ts"), "export const n = 1;\n", "utf8");
    const touches = capture.recordWorkingTreeTouches();
    expect(touches.map((t) => t.path.replace(/\\/g, "/"))).toContain("app.ts");
    expect(touches[0]?.action).toBe("created");

    capture.recordFileTouch("app.ts", "modified");
    capture.recordToolCall({
      command: "npm",
      args: ["test"],
      exit_code: 1,
      stderr: "failing",
      test_pass: false,
    });

    git(root, ["add", "app.ts"]);
    git(root, ["commit", "-m", "Add app.ts"]);

    const secondSnap = capture.captureGit();
    expect(secondSnap.recent_commits.map((c) => c.subject)).toEqual([
      "Add app.ts",
      "Initial commit",
    ]);
    expect(secondSnap.status).toEqual([]);

    capture.recordToolCall({
      command: "npm",
      args: ["test"],
      exit_code: 0,
      stdout: "ok",
      test_pass: true,
    });
    capture.endSession();

    const events = capture.getEvents();
    expect(typesOf(events)).toEqual([
      "session_start",
      "git_snapshot",
      "file_touch",
      "file_touch",
      "tool_call",
      "git_snapshot",
      "tool_call",
      "session_end",
    ]);

    expect(events[0]).toMatchObject({
      type: "session_start",
      session_id: "sess_test",
      agent: "claude-code",
      project_root: root,
    });

    const failing = events.find(
      (event) => event.type === "tool_call" && event.exit_code === 1,
    );
    expect(failing).toMatchObject({
      command: "npm",
      args: ["test"],
      test_pass: false,
    });

    const passing = events.find(
      (event) => event.type === "tool_call" && event.exit_code === 0,
    );
    expect(passing).toMatchObject({
      command: "npm",
      test_pass: true,
    });

    expect(events.at(-1)?.type).toBe("session_end");
    expect(events.every((event) => event.session_id === "sess_test")).toBe(true);
  });

  it("persists events to .dev-mem/events.jsonl", () => {
    const root = initSampleRepo();
    writeFileSync(join(root, "file.txt"), "x\n", "utf8");
    git(root, ["add", "file.txt"]);
    git(root, ["commit", "-m", "add file"]);

    const capture = new DeterministicCapture({
      projectRoot: root,
      agent: "cursor",
      sessionId: "sess_persist",
    });
    capture.startSession();
    capture.recordToolCall({ command: "ls", exit_code: 0 });
    capture.endSession();

    const logPath = join(root, ".dev-mem", "events.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "{}").type).toBe("session_start");
  });
});
