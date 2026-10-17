import { describe, it, expect } from "vitest";
import { compactSessionEventsForPrompt, pruneExtractedEvents } from "./compact.js";
import { EventLog } from "./log.js";
import { markExtractionComplete } from "../extraction-lock.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CaptureEvent, GitSnapshotEvent } from "./events.js";

describe("Event compaction and log pruning", () => {
  it("drops pre-execution sentinels, deduplicates Read calls, and caps passing stdout while preserving failing stderr", () => {
    const hugeStdout = "x".repeat(5000);
    const failStderr = "Error: SQLITE_BUSY: database is locked\n".repeat(20);
    const events: CaptureEvent[] = [
      { type: "session_start", id: "1", timestamp: "t1", session_id: "s1", agent: "codex", project_root: "/p" },
      { type: "tool_call", id: "2", timestamp: "t2", session_id: "s1", agent: "codex", command: "Read", args: ["a.ts"], exit_code: -1 },
      { type: "tool_call", id: "3", timestamp: "t3", session_id: "s1", agent: "codex", command: "Read", args: ["a.ts"], exit_code: 0, stdout: hugeStdout },
      { type: "tool_call", id: "4", timestamp: "t4", session_id: "s1", agent: "codex", command: "Read", args: ["a.ts"], exit_code: 0, stdout: hugeStdout },
      { type: "tool_call", id: "5", timestamp: "t5", session_id: "s1", agent: "codex", command: "npm test", args: [], exit_code: 1, stderr: failStderr },
    ];

    const compacted = compactSessionEventsForPrompt(events);
    // Pre-execution (-1) and duplicate Read on a.ts should be removed
    const toolCalls = compacted.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBe(2);
    expect((toolCalls[0] as any).stdout.length).toBeLessThanOrEqual(320);
    expect((toolCalls[1] as any).stderr).toContain("SQLITE_BUSY");
  });

  it("deduplicates consecutive status commands", () => {
    const events: CaptureEvent[] = [
      { type: "tool_call", id: "1", timestamp: "t1", session_id: "s1", agent: "codex", command: "git status", args: [], exit_code: 0, stdout: "clean" },
      { type: "tool_call", id: "2", timestamp: "t2", session_id: "s1", agent: "codex", command: "git status", args: [], exit_code: 0, stdout: "clean" },
      { type: "tool_call", id: "3", timestamp: "t3", session_id: "s1", agent: "codex", command: "git", args: ["status"], exit_code: 0, stdout: "clean" },
      { type: "tool_call", id: "4", timestamp: "t4", session_id: "s1", agent: "codex", command: "npm test", args: [], exit_code: 0, stdout: "pass" },
      { type: "tool_call", id: "5", timestamp: "t5", session_id: "s1", agent: "codex", command: "git status", args: [], exit_code: 0, stdout: "clean" },
    ];

    const compacted = compactSessionEventsForPrompt(events);
    const toolCalls = compacted.filter((e) => e.type === "tool_call");
    // Consecutive git status should be deduplicated (1 kept, 2 dropped, 3 is different command format but status - let's see, then npm test, then git status again kept)
    expect(toolCalls.some((t: any) => t.id === "1")).toBe(true);
    expect(toolCalls.some((t: any) => t.id === "2")).toBe(false);
    expect(toolCalls.some((t: any) => t.id === "4")).toBe(true);
    expect(toolCalls.some((t: any) => t.id === "5")).toBe(true);
  });

  it("truncates massive git diffs and strips diffs from non-final git snapshots", () => {
    const hugeDiff = "line\n".repeat(600);
    const events: CaptureEvent[] = [
      {
        type: "git_snapshot",
        id: "snap1",
        timestamp: "t1",
        session_id: "s1",
        agent: "claude-code",
        branch: "main",
        head_commit: "c1",
        worktree: "/p",
        worktrees: [],
        status: [],
        diff: "diff1",
        staged_diff: "sdiff1",
        recent_commits: [],
      },
      {
        type: "git_snapshot",
        id: "snap2",
        timestamp: "t2",
        session_id: "s1",
        agent: "claude-code",
        branch: "main",
        head_commit: "c2",
        worktree: "/p",
        worktrees: [],
        status: [],
        diff: hugeDiff,
        staged_diff: "x".repeat(30000),
        recent_commits: [],
      },
    ];

    const compacted = compactSessionEventsForPrompt(events);
    const snaps = compacted.filter((e) => e.type === "git_snapshot") as GitSnapshotEvent[];
    expect(snaps.length).toBe(2);
    // snap1 should have diffs emptied
    expect(snaps[0].diff).toBe("");
    expect(snaps[0].staged_diff).toBe("");
    // snap2 should have truncated diff (< 550 lines or <= 20KB + note)
    expect(snaps[1].diff).toContain("[diff truncated");
    expect(snaps[1].diff.split("\n").length).toBeLessThanOrEqual(510);
    expect(snaps[1].staged_diff).toContain("[diff truncated");
  });

  it("prunes already-extracted sessions from events.jsonl while keeping active sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-prune-"));
    try {
      const logPath = join(dir, ".dev-mem", "events.jsonl");
      const log = new EventLog({ persistPath: logPath });
      log.append({ type: "session_start", id: "1", timestamp: "t1", session_id: "done-sess", agent: "claude-code", project_root: dir });
      log.append({ type: "session_start", id: "2", timestamp: "t2", session_id: "active-sess", agent: "claude-code", project_root: dir });

      markExtractionComplete(dir, "done-sess");

      const res = pruneExtractedEvents(dir);
      expect(res.removedEvents).toBe(1);
      expect(res.keptEvents).toBe(1);

      const reloaded = new EventLog({ persistPath: logPath }).getEvents();
      expect(reloaded.map((e) => e.session_id)).toEqual(["active-sess"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 removed and 0 kept when events.jsonl does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-prune-empty-"));
    try {
      const res = pruneExtractedEvents(dir);
      expect(res).toEqual({ removedEvents: 0, keptEvents: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
