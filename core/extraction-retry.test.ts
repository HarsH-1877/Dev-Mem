import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventLog, newEventId, nowIso } from "./capture/log.js";
import { markExtractionComplete } from "./extraction-lock.js";
import { findPendingSessions, retryPendingExtractions, MAX_RETRY_ATTEMPTS, MAX_RETRIES_PER_START } from "./extraction-retry.js";

function addSession(dir: string, sessionId: string, opts: { ended: boolean; events?: number }) {
  const log = new EventLog({ persistPath: join(dir, ".dev-mem", "events.jsonl") });
  const base = { timestamp: nowIso(), session_id: sessionId, agent: "claude-code" };
  log.append({ ...base, id: newEventId(), type: "session_start", project_root: dir } as any);
  for (let i = 0; i < (opts.events ?? 1); i++) {
    log.append({ ...base, id: newEventId(), type: "tool_call", command: "npm", args: ["test"], exit_code: 0 } as any);
  }
  if (opts.ended) log.append({ ...base, id: newEventId(), type: "session_end" } as any);
}

describe("extraction retry", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dev-mem-retry-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("finds ended sessions that were never marked complete", () => {
    addSession(dir, "failed-one", { ended: true });
    expect(findPendingSessions(dir, "current")).toEqual(["failed-one"]);
  });

  it("ignores the current session, completed sessions, and sessions still running", () => {
    addSession(dir, "current", { ended: true });
    addSession(dir, "done-one", { ended: true });
    markExtractionComplete(dir, "done-one");
    addSession(dir, "still-running", { ended: false });
    expect(findPendingSessions(dir, "current")).toEqual([]);
  });

  it("ignores ended sessions that captured nothing beyond start/end", () => {
    addSession(dir, "empty", { ended: true, events: 0 });
    expect(findPendingSessions(dir, "current")).toEqual([]);
  });

  it("spawns an extraction for each pending session, capped per start", () => {
    for (let i = 0; i < MAX_RETRIES_PER_START + 2; i++) addSession(dir, `s${i}`, { ended: true });
    const spawned: string[] = [];
    const result = retryPendingExtractions(dir, "current", (id) => spawned.push(id));
    expect(spawned).toHaveLength(MAX_RETRIES_PER_START);
    expect(result).toEqual(spawned);
  });

  it("gives up on a session after MAX_RETRY_ATTEMPTS", () => {
    addSession(dir, "always-fails", { ended: true });
    const spawned: string[] = [];
    for (let i = 0; i < MAX_RETRY_ATTEMPTS + 2; i++) {
      retryPendingExtractions(dir, "current", (id) => spawned.push(id));
    }
    expect(spawned).toHaveLength(MAX_RETRY_ATTEMPTS);
    expect(findPendingSessions(dir, "current")).toEqual([]);
  });

  it("never throws when there is no event log", () => {
    expect(retryPendingExtractions(dir, "current", () => {})).toEqual([]);
  });
});
