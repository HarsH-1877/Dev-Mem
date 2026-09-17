import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../../core/graph/index.js";
import { checkRegressionRisk, formatRegressionWarning } from "../../core/regression/index.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dev-mem-regression-test-"));
  dbPath = join(tmpDir, "graph.sqlite");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedStore(nodes: Array<{
  files?: string[];
  confidence?: number;
  title?: string;
  state?: string;
}>) {
  const store = new GraphStore({ dbPath, ephemeral: true });
  const created = nodes.map((n) =>
    store.createNode({
      type: "FailedApproach",
      title: n.title ?? "Client-side token verification caused inconsistent state",
      content: "Detail of what went wrong.",
      lifecycle_state: (n.state as any) ?? "observed",
      evidence: {
        commit: "a1b2c3d4",
        files: n.files ?? ["src/auth/verify.ts"],
        confidence: n.confidence ?? 0.86,
        session_id: "sess_001",
        agent: "claude-code",
        timestamp: new Date().toISOString(),
      },
    })
  );
  store.close();
  return created;
}

describe("checkRegressionRisk", () => {
  it("returns empty when currentFiles is empty", () => {
    seedStore([{}]);

    const matches = checkRegressionRisk({
      projectRoot: tmpDir,
      dbPath,
      currentFiles: [],
    });
    expect(matches).toHaveLength(0);
  });

  it("detects overlap when a current file matches a FailedApproach", () => {
    seedStore([{ files: ["src/auth/verify.ts"] }]);

    const matches = checkRegressionRisk({
      projectRoot: tmpDir,
      dbPath,
      currentFiles: ["src/auth/verify.ts", "src/auth/login.ts"],
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].overlapRatio).toBe(1.0);
    expect(matches[0].node.title).toContain("token verification");
  });

  it("does not surface when confidence is below threshold", () => {
    seedStore([{ files: ["src/auth/verify.ts"], confidence: 0.4 }]);

    const matches = checkRegressionRisk({
      projectRoot: tmpDir,
      dbPath,
      currentFiles: ["src/auth/verify.ts"],
      confidenceThreshold: 0.6,
    });
    expect(matches).toHaveLength(0);
  });

  it("skips superseded nodes", () => {
    const store = new GraphStore({ dbPath, ephemeral: true });
    const n = store.createNode({
      type: "FailedApproach",
      title: "Old failed approach",
      evidence: {
        commit: "abc",
        files: ["src/auth/verify.ts"],
        confidence: 0.9,
        session_id: "sess_x",
        agent: "claude-code",
        timestamp: new Date().toISOString(),
      },
    });
    store.transitionLifecycleState(n.id, "superseded");
    store.close();

    const matches = checkRegressionRisk({
      projectRoot: tmpDir,
      dbPath,
      currentFiles: ["src/auth/verify.ts"],
    });
    expect(matches).toHaveLength(0);
  });

  it("returns matches sorted by overlap ratio descending", () => {
    seedStore([
      { files: ["src/auth/verify.ts", "src/auth/tokens.ts"], title: "Two-file approach" },
      { files: ["src/auth/verify.ts"], title: "Single-file approach" },
    ]);

    const matches = checkRegressionRisk({
      projectRoot: tmpDir,
      dbPath,
      currentFiles: ["src/auth/verify.ts"],
    });

    expect(matches).toHaveLength(2);
    // Single-file: 1/1 = 1.0 overlap; Two-file: 1/2 = 0.5 overlap
    expect(matches[0].node.title).toBe("Single-file approach");
    expect(matches[0].overlapRatio).toBe(1.0);
    expect(matches[1].overlapRatio).toBeCloseTo(0.5);
  });
});

describe("formatRegressionWarning", () => {
  it("returns empty string for no matches", () => {
    expect(formatRegressionWarning([])).toBe("");
  });

  it("formats a match with spec §8.1 format", () => {
    seedStore([{ files: ["src/auth/verify.ts"] }]);

    const matches = checkRegressionRisk({
      projectRoot: tmpDir,
      dbPath,
      currentFiles: ["src/auth/verify.ts"],
    });

    const output = formatRegressionWarning(matches);
    expect(output).toContain("⚠");
    expect(output).toContain("already tried and failed");
    expect(output).toContain("token verification");
    expect(output).toContain("sess_001");
    expect(output).toContain("a1b2c3d"); // 7-char commit prefix
    expect(output).toContain("confidence: 0.86");
    expect(output).toContain("file overlap: 100%");
    expect(output).toContain("<dev_mem_regression_warning>");
    expect(output).toContain("</dev_mem_regression_warning>");
  });

  it("includes file list and detail content", () => {
    seedStore([{ files: ["src/auth/verify.ts", "src/auth/tokens.ts"] }]);

    const matches = checkRegressionRisk({
      projectRoot: tmpDir,
      dbPath,
      currentFiles: ["src/auth/verify.ts"],
    });

    const output = formatRegressionWarning(matches);
    expect(output).toContain("src/auth/verify.ts");
    expect(output).toContain("Detail of what went wrong");
  });
});
