import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DeterministicCapture } from "../capture/index.js";
import { GraphStore } from "../graph/index.js";
import { validateEvidence } from "../graph/evidence.js";
import { runExtraction } from "./index.js";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: dir,
    stdio: "ignore",
  });
  writeFileSync(join(dir, "README.md"), "# Test Repo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial commit"], {
    cwd: dir,
    stdio: "ignore",
  });
}

describe("Batched LLM Extraction (spec §7.2)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "dev-mem-extract-test-"));
    initGitRepo(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("extracts typed nodes from real captured events and verifies §5.4 evidence compliance", async () => {
    const sessionId = "session-m3-test-1";
    const capture = new DeterministicCapture({
      projectRoot: testDir,
      agent: "claude-code",
      sessionId,
    });

    // Simulate realistic session activity
    capture.startSession();
    capture.captureGit();
    capture.recordFileTouch("src/auth.ts", "created");
    capture.recordToolCall({
      command: "npm test",
      args: ["--", "auth.spec.ts"],
      exit_code: 0,
      stdout: "Tests passed: 3",
      test_pass: true,
    });
    capture.endSession();

    // Run extraction on the session events
    const result = await runExtraction({
      projectRoot: testDir,
      sessionId,
      mockLlm: true,
    });

    expect(result.success).toBe(true);
    expect(result.nodes.length).toBeGreaterThan(0);

    // Verify stored in GraphStore
    const store = new GraphStore({ projectRoot: testDir });
    for (const node of result.nodes) {
      const retrieved = store.getNode(node.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe(node.title);

      // Verify node lifecycle state starts strictly as 'observed' (§5.3)
      expect(retrieved?.lifecycle_state).toBe("observed");

      // Verify node types match §5.1 valid set
      expect([
        "Decision",
        "FailedApproach",
        "Constraint",
        "Discovery",
        "Convention",
        "OpenIssue",
      ]).toContain(retrieved?.type);

      // Verify evidence matches §5.4 schema exactly via validateEvidence
      expect(() => validateEvidence(retrieved!.evidence)).not.toThrow();
      expect(retrieved?.evidence.commit).toBeTruthy();
      expect(retrieved?.evidence.commit).not.toBe("");
      expect(retrieved?.evidence.files.length).toBeGreaterThanOrEqual(1);
      expect(retrieved?.evidence.session_id).toBe(sessionId);
      expect(retrieved?.evidence.agent).toBe("claude-code");
      expect(typeof retrieved?.evidence.confidence).toBe("number");
      expect(retrieved?.evidence.confidence).toBeGreaterThanOrEqual(0);
      expect(retrieved?.evidence.confidence).toBeLessThanOrEqual(1);

      // Verify symbols is empty array per §10 non-goal
      expect(retrieved?.evidence.symbols).toEqual([]);
    }
    store.close();
  });

  it("extracts diverse node types with optional diff_ref and test_ref from custom LLM output", async () => {
    const sessionId = "session-m3-custom-output";
    const capture = new DeterministicCapture({
      projectRoot: testDir,
      agent: "claude-code",
      sessionId,
    });

    capture.startSession();
    capture.recordFileTouch("src/db.ts", "modified");
    capture.endSession();

    const customLlmResponse = JSON.stringify({
      nodes: [
        {
          type: "Decision",
          title: "Adopt better-sqlite3 for synchronous storage",
          content: "Replaced asynchronous/experimental driver with better-sqlite3.",
          files: ["src/db.ts"],
          confidence: 0.94,
          diff_ref: "HEAD~1..HEAD",
        },
        {
          type: "FailedApproach",
          title: "In-memory driver without persistence",
          content: "Using pure memory driver resulted in loss of state on session restarts.",
          files: ["src/db.ts"],
          confidence: 0.89,
          test_ref: "tests/db.spec.ts",
        },
        {
          type: "Constraint",
          title: "All graph queries must use GraphStore public interface",
          content: "Raw SQL queries must not leak outside of GraphStore implementation.",
          files: ["src/db.ts"],
          confidence: 0.98,
        },
      ],
    });

    const result = await runExtraction({
      projectRoot: testDir,
      sessionId,
      customLlmResponse,
    });

    expect(result.success).toBe(true);
    expect(result.nodes.length).toBe(3);

    const store = new GraphStore({ projectRoot: testDir });
    const decisions = store.queryByType("Decision");
    const failed = store.queryByType("FailedApproach");
    const constraints = store.queryByType("Constraint");

    expect(decisions.length).toBe(1);
    expect(decisions[0].evidence.diff_ref).toBe("HEAD~1..HEAD");
    expect(decisions[0].lifecycle_state).toBe("observed");

    expect(failed.length).toBe(1);
    expect(failed[0].evidence.test_ref).toBe("tests/db.spec.ts");

    expect(constraints.length).toBe(1);
    expect(constraints[0].evidence.confidence).toBe(0.98);

    for (const n of [...decisions, ...failed, ...constraints]) {
      expect(() => validateEvidence(n.evidence)).not.toThrow();
    }
    store.close();
  });

  it("handles LLM parse failures gracefully without throwing", async () => {
    const sessionId = "session-m3-bad-json";
    const capture = new DeterministicCapture({
      projectRoot: testDir,
      agent: "claude-code",
      sessionId,
    });

    capture.startSession();
    capture.endSession();

    // Malformed JSON output
    const result = await runExtraction({
      projectRoot: testDir,
      sessionId,
      customLlmResponse: "I am an LLM and this is not valid JSON at all.",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to parse LLM JSON output");
    expect(result.nodes).toEqual([]);
  });

  it("handles missing sessions gracefully without crashing", async () => {
    const result = await runExtraction({
      projectRoot: testDir,
      sessionId: "non-existent-session-id",
      mockLlm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No events found");
  });

  it("gracefully ignores nodes with invalid node types while inserting valid ones", async () => {
    const sessionId = "session-m3-invalid-type";
    const capture = new DeterministicCapture({
      projectRoot: testDir,
      agent: "claude-code",
      sessionId,
    });

    capture.startSession();
    capture.endSession();

    const customLlmResponse = JSON.stringify({
      nodes: [
        {
          type: "InvalidNodeTypeNotInSpec",
          title: "Should be skipped",
          content: "Invalid",
          files: ["foo.ts"],
          confidence: 0.5,
        },
        {
          type: "Discovery",
          title: "Valid discovery node",
          content: "Valid",
          files: ["foo.ts"],
          confidence: 0.85,
        },
      ],
    });

    const result = await runExtraction({
      projectRoot: testDir,
      sessionId,
      customLlmResponse,
    });

    expect(result.success).toBe(true);
    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].type).toBe("Discovery");
  });
});
