import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../graph/index.js";
import { appendExtractionLog } from "../local-data.js";
import { filterUnseenNodes, filterUnseenWarnings } from "../retrieval/session-dedup.js";
import { collectStats } from "./index.js";

const EV = {
  commit: "1111111111111111111111111111111111111111",
  files: ["src/app.ts"],
  session_id: "s-tel",
  agent: "claude-code",
  timestamp: "2026-10-16T00:00:00.000Z",
  confidence: 0.9,
};

describe("Local Telemetry & dev-memo stats (core/telemetry)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-telemetry-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // ignore transient Windows locks
    }
  });

  it("aggregates injections, regression warnings, extractions, and verified counts", () => {
    const store = new GraphStore({ projectRoot: dir });
    const n1 = store.createNode({
      type: "Decision",
      title: "Verified decision",
      content: "Detail",
      lifecycle_state: "verified",
      evidence: EV,
    });
    const n2 = store.createNode({
      type: "FailedApproach",
      title: "Avoid raw SQL interpolation",
      content: "Injection vulnerability",
      lifecycle_state: "active",
      evidence: EV,
    });
    store.close();

    filterUnseenNodes(dir, "sess-1", [{ id: n1.id }, { id: n2.id }]);
    filterUnseenWarnings(dir, "sess-1", [{ node: n2 }]);

    appendExtractionLog(dir, {
      timestamp: new Date().toISOString(),
      session_id: "sess-1",
      provider: "cli-claude",
      success: true,
      nodes_created: 2,
    });
    appendExtractionLog(dir, {
      timestamp: new Date().toISOString(),
      session_id: "sess-2",
      provider: "cli-claude",
      success: false,
      nodes_created: 0,
      error: "timeout",
    });

    const stats = collectStats(dir);
    expect(existsSync(join(dir, ".dev-mem", "telemetry.jsonl"))).toBe(true);
    expect(stats.totalNodes).toBe(2);
    expect(stats.verifiedNodes).toBe(1);
    expect(stats.totalInjections).toBe(2);
    expect(stats.preventedRegressions).toBe(1);
    expect(stats.sessionsAssisted).toBeGreaterThanOrEqual(1);
    expect(stats.extractions).toEqual({ total: 2, succeeded: 1, failed: 1 });
  });
});
