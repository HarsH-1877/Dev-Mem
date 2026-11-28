import { describe, it, expect } from "vitest";
import { runMultiRepoBenchmark, formatBenchmarkMarkdown } from "./multi-repo-eval.js";

describe("Multi-repo FTS5/BM25 & regression guard benchmark (v0.8)", () => {
  it("evaluates 24 sessions across 3 repositories with high MRR and zero negative leakage", () => {
    const report = runMultiRepoBenchmark();
    expect(report.repos.length).toBe(3);
    expect(report.totals.sessionsEvaluated).toBe(24);
    expect(report.totals.hybridHitAt1Rate).toBeGreaterThanOrEqual(0.85);
    expect(report.totals.hybridRecallAt3Rate).toBeGreaterThanOrEqual(0.95);
    expect(report.totals.hybridMrr).toBeGreaterThanOrEqual(report.totals.baselineMrr);
    expect(report.totals.negativeLeakageRate).toBe(0);
    expect(report.totals.regressionNoiseSuppressionRate).toBe(1);

    for (const r of report.repos) {
      expect(r.warningDedupVerified).toBe(r.regressionNoiseTotal);
    }

    const md = formatBenchmarkMarkdown(report);
    expect(md).toContain("dev-mem-cli");
    expect(md).toContain("ts-saas-api");
    expect(md).toContain("fullstack-monorepo");
  });
});
