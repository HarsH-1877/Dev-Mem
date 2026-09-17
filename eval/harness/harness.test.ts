import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DeterministicCapture } from "../../core/capture/index.js";
import { runExtraction } from "../../core/extraction/index.js";
import { retrieveContext } from "../../core/retrieval/index.js";
import { checkRegressionRisk } from "../../core/regression/index.js";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@dev-mem.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("Eval Harness Components", () => {
  it("simulates a 2-task sequence with knowledge preservation", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "dev-mem-harness-test-"));
    
    try {
      initGitRepo(testDir);

      // Task 1: Make a decision
      const session1 = "task-1-decision";
      const capture1 = new DeterministicCapture({
        projectRoot: testDir,
        agent: "claude-code",
        sessionId: session1
      });
      capture1.startSession();
      capture1.captureGit();
      writeFileSync(join(testDir, "architecture.md"), "Use in-memory store\n", "utf8");
      capture1.recordFileTouch("architecture.md", "created");
      execFileSync("git", ["add", "."], { cwd: testDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "Task 1"], { cwd: testDir, stdio: "ignore" });
      capture1.endSession();

      // Extract knowledge from task 1
      const extract1 = await runExtraction({
        projectRoot: testDir,
        sessionId: session1,
        mockLlm: true
      });
      expect(extract1.success).toBe(true);
      expect(extract1.nodes.length).toBeGreaterThan(0);

      // Task 2: Should retrieve task 1's knowledge
      const session2 = "task-2-depends";
      const capture2 = new DeterministicCapture({
        projectRoot: testDir,
        agent: "claude-code",
        sessionId: session2
      });
      capture2.startSession();
      
      // Retrieve context (simulating Dev-Mem injection)
      const retrieved = retrieveContext({
        projectRoot: testDir,
        budgetTokens: 1000,
        currentFiles: ["store.js"]
      });
      
      expect(retrieved.length).toBeGreaterThan(0);
      expect(retrieved[0].type).toBe("Decision");
      
      capture2.endSession();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("detects regression risk when re-attempting failed approach", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "dev-mem-regression-test-"));
    
    try {
      initGitRepo(testDir);

      // Task 1: Record a failed approach
      const session1 = "task-failed";
      const capture1 = new DeterministicCapture({
        projectRoot: testDir,
        agent: "claude-code",
        sessionId: session1
      });
      capture1.startSession();
      writeFileSync(join(testDir, "db.js"), "// SQLite attempt\n", "utf8");
      capture1.recordFileTouch("db.js", "created");
      capture1.recordToolCall({ command: "npm", args: ["test"], exit_code: 1, test_pass: false });
      execFileSync("git", ["add", "."], { cwd: testDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "Failed SQLite"], { cwd: testDir, stdio: "ignore" });
      capture1.endSession();

      // Extract with custom response marking it as failed approach
      const customResponse = JSON.stringify({
        nodes: [{
          type: "FailedApproach",
          title: "SQLite direct implementation failed",
          content: "Conflicts with architecture decision",
          files: ["db.js"],
          confidence: 0.9
        }]
      });

      const extract = await runExtraction({
        projectRoot: testDir,
        sessionId: session1,
        customLlmResponse: customResponse
      });
      expect(extract.success).toBe(true);

      // Task 2: Try same file again — should trigger regression warning
      const warnings = checkRegressionRisk({
        projectRoot: testDir,
        currentFiles: ["db.js"],
        confidenceThreshold: 0.6
      });

      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].node.title).toContain("SQLite");
      expect(warnings[0].overlapRatio).toBe(1.0);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
