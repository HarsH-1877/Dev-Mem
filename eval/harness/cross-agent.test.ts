import { describe, expect, it } from "vitest";
import {
  computeCrossAgentMetrics,
  runCrossAgentEvaluation,
} from "./cross-agent.js";

describe("Cross-agent evaluation harness", () => {
  it("retrieves Claude Code knowledge for Codex and flags its SQLite re-attempt", async () => {
    const on = await runCrossAgentEvaluation("ON");

    expect(on.totalCrossAgentNodesRetrieved).toBeGreaterThan(0);
    expect(on.crossAgentRegressionFired).toBe(true);

    const task7 = on.tasks.find((task) => task.taskId === 7);
    expect(task7?.agent).toBe("codex");
    expect(task7?.crossAgentNodesInjected).toBeGreaterThan(0);
    expect(task7?.regressionWarningShown).toBe(true);
  }, 30_000);

  it("keeps token accounting net-positive across the handoff", async () => {
    const [off, on] = await Promise.all([
      runCrossAgentEvaluation("OFF"),
      runCrossAgentEvaluation("ON"),
    ]);
    const metrics = computeCrossAgentMetrics(off, on);

    expect(metrics.redundantDiscoveryAvoided).toBeGreaterThan(0);
    expect(metrics.netTokenDelta).toBeGreaterThan(0);
  }, 30_000);
});
