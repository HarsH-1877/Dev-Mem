import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureEvent, GitSnapshotEvent, ToolCallEvent } from "./events.js";
import { EventLog } from "./log.js";
import { isExtractionComplete } from "../extraction-lock.js";
import { getEventsLogPath } from "../local-data.js";

const PASS_STDOUT_LIMIT = 300;
const MAX_DIFF_LINES = 500;
const MAX_DIFF_BYTES = 20 * 1024; // 20KB

function truncate(text: string | undefined, max: number): string | undefined {
  if (!text) return text;
  return text.length > max ? text.slice(0, max) + "...[truncated]" : text;
}

function truncateDiff(diff: string | undefined): string {
  if (!diff) return "";
  let result = diff;
  const lines = result.split("\n");
  if (lines.length > MAX_DIFF_LINES) {
    result = lines.slice(0, MAX_DIFF_LINES).join("\n") + "\n...[diff truncated at 500 lines]";
  }
  if (result.length > MAX_DIFF_BYTES) {
    result = result.slice(0, MAX_DIFF_BYTES) + "...[diff truncated at 20KB]";
  }
  return result;
}

function getStatusKey(tc: ToolCallEvent): string | null {
  const cmd = tc.command?.toLowerCase()?.trim();
  if (!cmd) return null;
  const firstArg = tc.args?.[0]?.toLowerCase()?.trim();
  if (cmd === "status" || cmd === "git status") {
    return `${cmd} ${(tc.args || []).join(" ")}`.trim();
  }
  if (cmd === "git" && firstArg === "status") {
    return `git status ${(tc.args.slice(1) || []).join(" ")}`.trim();
  }
  return null;
}

/**
 * Deterministically compacts raw session events before building the LLM extraction
 * prompt, reducing token usage by 70-90% while preserving failure diagnostics.
 */
export function compactSessionEventsForPrompt(events: CaptureEvent[]): CaptureEvent[] {
  const result: CaptureEvent[] = [];
  const seenReads = new Set<string>();

  // Identify the index of the last git_snapshot so earlier snapshots can drop bulky diffs
  let lastGitSnapIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "git_snapshot") {
      lastGitSnapIdx = i;
      break;
    }
  }

  let lastStatusKey: string | null = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    if (ev.type === "tool_call") {
      const tc = ev as ToolCallEvent;
      // Drop pre-execution sentinel events (exit_code === -1)
      if (tc.exit_code === -1) continue;

      // Deduplicate repeated Read calls on the same file
      if (tc.command.toLowerCase() === "read" && tc.args && tc.args.length > 0) {
        const readKey = tc.args[0];
        if (seenReads.has(readKey)) continue;
        seenReads.add(readKey);
      }

      // Deduplicate consecutive status commands (e.g. repeated `git status`)
      const statusKey = getStatusKey(tc);
      if (statusKey) {
        if (lastStatusKey === statusKey) continue;
        lastStatusKey = statusKey;
      } else {
        lastStatusKey = null;
      }

      const isFailure = tc.exit_code !== 0;
      // Preserve full failure diagnostics; truncate passing tool stdout
      const stdout = isFailure ? tc.stdout : truncate(tc.stdout, PASS_STDOUT_LIMIT);
      const stderr = isFailure ? tc.stderr : truncate(tc.stderr, PASS_STDOUT_LIMIT);

      result.push({
        ...tc,
        stdout,
        stderr,
      });
      continue;
    }

    if (ev.type === "git_snapshot") {
      const gs = ev as GitSnapshotEvent;
      if (i !== lastGitSnapIdx) {
        result.push({ ...gs, diff: "", staged_diff: "" });
      } else {
        result.push({
          ...gs,
          diff: truncateDiff(gs.diff),
          staged_diff: truncateDiff(gs.staged_diff),
        });
      }
      continue;
    }

    result.push(ev);
  }

  return result;
}

/**
 * Atomically prunes events belonging to sessions that have already been
 * extracted into the SQLite graph store.
 */
export function pruneExtractedEvents(projectRoot: string): { removedEvents: number; keptEvents: number } {
  const logPath = getEventsLogPath(projectRoot);
  if (!existsSync(logPath)) {
    return { removedEvents: 0, keptEvents: 0 };
  }

  const log = new EventLog({ persistPath: logPath });
  const allEvents = log.getEvents();
  const kept: CaptureEvent[] = [];
  let removedEvents = 0;

  const completionCache = new Map<string, boolean>();
  for (const ev of allEvents) {
    let done = completionCache.get(ev.session_id);
    if (done === undefined) {
      done = isExtractionComplete(projectRoot, ev.session_id);
      completionCache.set(ev.session_id, done);
    }
    if (done) {
      removedEvents++;
    } else {
      kept.push(ev);
    }
  }

  if (removedEvents > 0) {
    const tmpPath = join(projectRoot, ".dev-mem", `events.jsonl.tmp.${process.pid}`);
    const body = kept.length > 0 ? kept.map((e) => JSON.stringify(e)).join("\n") + "\n" : "";
    writeFileSync(tmpPath, body, "utf8");
    try {
      renameSync(tmpPath, logPath);
    } catch {
      // Fallback for Windows file replacement issues
      writeFileSync(logPath, body, "utf8");
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  return { removedEvents, keptEvents: kept.length };
}
