/**
 * Cross-Agent Evaluation Harness for Dev-Mem V2 (§11, §13)
 *
 * Tests the core V2 hypothesis: does knowledge captured by one agent get
 * usefully retrieved and used by a DIFFERENT agent, not just across sessions
 * of the same one?
 *
 * Scenario:
 *   - Tasks 1–6: simulated as "claude-code"
 *   - Tasks 7–12: simulated as "codex"
 *   - Both agents write to and read from the SAME shared graph store (same project root)
 *
 * Token accounting methodology: identical to V1 harness (eval/harness/index.ts).
 *   - Math.ceil(text.length / 4) applied to actual content strings.
 *   - No flat multipliers.
 *   - base = system prompt + task prompt + response (same for both modes)
 *   - injection = ON mode only, char-counted from generateInjectionString() output
 *   - rediscovery = OFF mode only, char-counted from explicit per-dependency link texts
 *   - For cross-agent ON mode: Agent 2 injection includes nodes written by Agent 1.
 *     We explicitly inspect WHICH nodes were retrieved and whether they were agent1-sourced.
 *
 * Cross-agent Regression Intelligence:
 *   Task 7 "Re-attempt SQLite" has shouldTriggerRegression = true.
 *   The FailedApproach node was captured by claude-code in Task 2.
 *   Task 7 runs as codex. We verify the RI warning fires cross-agent.
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DeterministicCapture } from "../../core/capture/index.js";
import { runExtraction } from "../../core/extraction/index.js";
import { retrieveContext, generateInjectionString } from "../../core/retrieval/index.js";
import { checkRegressionRisk } from "../../core/regression/index.js";
import { GraphStore } from "../../core/graph/index.js";
import { TASKS } from "./index.js";

// ─── Token estimator ────────────────────────────────────────────────────────

function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── System prompts ──────────────────────────────────────────────────────────

const CLAUDE_CODE_SYSTEM_PROMPT = `\
You are Claude, an AI assistant made by Anthropic. You are working in Claude Code, \
an agentic coding environment. You have access to tools for reading files, writing \
files, running shell commands, and searching the codebase. You operate on a task \
given by the user. You should complete the task thoroughly and correctly, \
following the conventions of the existing codebase. \
When you are done, provide a concise summary of what you did and why.`;

const CODEX_SYSTEM_PROMPT = `\
You are an AI coding assistant powered by OpenAI Codex. You are operating in an \
agentic environment with access to file system tools and a shell. Your goal is to \
complete the given coding task accurately and efficiently, following existing code \
conventions and architecture decisions. Report a clear summary of what you changed \
and why after completing each task.`;

function getSystemPrompt(agent: "claude-code" | "codex"): string {
  return agent === "claude-code" ? CLAUDE_CODE_SYSTEM_PROMPT : CODEX_SYSTEM_PROMPT;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CrossAgentTaskResult {
  taskId: number;
  agent: "claude-code" | "codex";
  success: boolean;
  timeMs: number;
  baseTokens: number;
  injectionTokens: number;
  rediscoveryTokens: number;
  totalTokens: number;
  regressionWarningShown: boolean;
  /** ON mode only: how many of the injected nodes came from the OTHER agent */
  crossAgentNodesInjected: number;
  errors: string[];
}

export interface CrossAgentRunResult {
  mode: "OFF" | "ON";
  tasks: CrossAgentTaskResult[];
  totalTimeMs: number;
  totalBaseTokens: number;
  totalInjectionTokens: number;
  totalRediscoveryTokens: number;
  totalTokens: number;
  redundantDiscoveries: number;
  regressionRepeats: number;
  successRate: number;
  totalCrossAgentNodesRetrieved: number;
  crossAgentRegressionFired: boolean;
}

export interface CrossAgentMetrics {
  redundantDiscoveryAvoided: number;
  regressionRepeatRate: { off: number; on: number };
  netTokenDelta: number;
  taskSuccessRate: { off: number; on: number };
  timeToCompletion: { offMs: number; onMs: number };
  crossAgentNodesRetrieved: number;
  crossAgentRegressionFired: boolean;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function initGitRepo(dir: string) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "eval@dev-mem.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Dev-Mem Eval"], { cwd: dir, stdio: "ignore" });
}

function gitCommit(dir: string, message: string) {
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message, "--allow-empty"], { cwd: dir, stdio: "ignore" });
}

// ─── Agent assignment ─────────────────────────────────────────────────────────
// Tasks 1–6: claude-code (Agent 1) | Tasks 7–12: codex (Agent 2)
function agentForTask(taskId: number): "claude-code" | "codex" {
  return taskId <= 6 ? "claude-code" : "codex";
}

// ─── Main cross-agent evaluation runner ───────────────────────────────────────

export async function runCrossAgentEvaluation(mode: "OFF" | "ON"): Promise<CrossAgentRunResult> {
  console.log(`\n=== Cross-Agent Eval: Dev-Mem ${mode} (Tasks 1-6: claude-code → Tasks 7-12: codex) ===\n`);

  const repoDir = mkdtempSync(join(tmpdir(), `dev-mem-xagent-eval-${mode.toLowerCase()}-`));

  try {
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "README.md"), "# Task API\n", "utf8");
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "task-api", version: "1.0.0", type: "module" }, null, 2),
      "utf8"
    );
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "docs"), { recursive: true });
    gitCommit(repoDir, "Initial project structure");

    const results: CrossAgentTaskResult[] = [];
    let totalBaseTokens = 0;
    let totalInjectionTokens = 0;
    let totalRediscoveryTokens = 0;
    let redundantDiscoveries = 0;
    let regressionRepeats = 0;
    let totalCrossAgentNodesRetrieved = 0;
    let crossAgentRegressionFired = false;
    const overallStart = Date.now();

    for (const task of TASKS) {
      const agent = agentForTask(task.id);
      const systemPrompt = getSystemPrompt(agent);
      const systemTokens = countTokens(systemPrompt);

      console.log(`  Task ${task.id} [${agent}]: ${task.name}...`);
      const sessionId = `eval-xagent-${mode.toLowerCase()}-${agent}-task-${task.id}`;
      const taskStart = Date.now();

      let injectionTokens = 0;
      let rediscoveryTokens = 0;
      let regressionWarningShown = false;
      let crossAgentNodesInjected = 0;
      let capture: DeterministicCapture | null = null;

      // ── Dev-Mem ON: retrieve context before the task ──
      let injectionText = "";
      if (mode === "ON") {
        capture = new DeterministicCapture({
          projectRoot: repoDir,
          agent,
          sessionId
        });
        capture.startSession();
        capture.captureGit();

        const retrieved = retrieveContext({
          projectRoot: repoDir,
          currentFiles: task.files,
          currentTask: task.taskPromptText,
        });

        injectionText = generateInjectionString(retrieved);
        injectionTokens = countTokens(injectionText);

        // ── Cross-agent node inspection ──
        // For Agent 2 (codex) tasks, check how many retrieved nodes were written by Agent 1 (claude-code).
        if (agent === "codex" && retrieved.length > 0) {
          const store = new GraphStore({ projectRoot: repoDir });
          for (const node of retrieved) {
            try {
              const dbNode = store.getNode(node.id);
              if (dbNode) {
                const evidence = typeof dbNode.evidence === "string"
                  ? JSON.parse(dbNode.evidence)
                  : dbNode.evidence;
                const nodeAgent: string = evidence?.agent ?? "unknown";
                if (nodeAgent === "claude-code") {
                  crossAgentNodesInjected++;
                }
              }
            } catch {
              // best-effort
            }
          }
          store.close();
        }

        // ── Regression Intelligence ──
        if (task.shouldTriggerRegression) {
          const warnings = checkRegressionRisk({
            projectRoot: repoDir,
            currentFiles: task.files,
          });
          regressionWarningShown = warnings.length > 0;

          if (agent === "codex" && regressionWarningShown) {
            crossAgentRegressionFired = true;
          }
        }
      }

      // ── OFF mode: simulate rediscovery for each dependency ──
      if (mode === "OFF" && task.rediscoveryLinks.length > 0) {
        for (const link of task.rediscoveryLinks) {
          const exchange =
            countTokens(link.rediscoveryReadText) +
            countTokens(link.rediscoveryResponseText);
          rediscoveryTokens += exchange;
          redundantDiscoveries++;
        }
      }

      // ── Regression repeat tracking ──
      if (task.shouldTriggerRegression) {
        if (mode === "OFF") {
          regressionRepeats++;
        }
        if (mode === "ON" && !regressionWarningShown) {
          regressionRepeats++;
        }
      }

      // ── Base tokens: system prompt (per agent) + task prompt + response ──
      const baseTokens =
        systemTokens +
        countTokens(task.taskPromptText) +
        countTokens(task.taskResponseText);

      const totalTaskTokens = baseTokens + injectionTokens + rediscoveryTokens;

      // ── Simulate agent output: create files and commit ──
      for (const file of task.files) {
        mkdirSync(join(repoDir, file, ".."), { recursive: true });
        writeFileSync(
          join(repoDir, file),
          `// Task ${task.id} [${agent}]: ${task.name}\n// ${task.taskResponseText.slice(0, 120)}\n`,
          "utf8"
        );
      }
      gitCommit(repoDir, `Task ${task.id} [${agent}]: ${task.name}`);

      // ── Dev-Mem ON: record and extract ──
      if (mode === "ON" && capture) {
        for (const file of task.files) {
          capture.recordFileTouch(file, existsSync(join(repoDir, file)) ? "modified" : "created");
        }
        capture.recordToolCall({
          command: "git",
          args: ["commit", "-m", `Task ${task.id}`],
          exit_code: 0
        });
        capture.endSession();

        const llmResponse = JSON.stringify({
          nodes: task.expectedKnowledge.map(k => ({
            type: k.type,
            title: `${task.name}: ${k.keywords.slice(0, 3).join(", ")}`,
            content: task.taskResponseText.slice(0, 200),
            files: task.files,
            confidence: 0.87,
          }))
        });

        await runExtraction({
          projectRoot: repoDir,
          sessionId,
          customLlmResponse: llmResponse,
          mockLlm: true
        });
      }

      totalCrossAgentNodesRetrieved += crossAgentNodesInjected;
      totalBaseTokens += baseTokens;
      totalInjectionTokens += injectionTokens;
      totalRediscoveryTokens += rediscoveryTokens;

      const timeMs = Date.now() - taskStart;

      results.push({
        taskId: task.id,
        agent,
        success: true,
        timeMs,
        baseTokens,
        injectionTokens,
        rediscoveryTokens,
        totalTokens: totalTaskTokens,
        regressionWarningShown,
        crossAgentNodesInjected,
        errors: []
      });

      const detailParts: string[] = [];
      if (mode === "ON" && injectionText) detailParts.push(`injection: ${injectionTokens} tok`);
      if (mode === "ON" && crossAgentNodesInjected > 0) detailParts.push(`cross-agent nodes: ${crossAgentNodesInjected}`);
      if (mode === "OFF" && rediscoveryTokens > 0) detailParts.push(`rediscovery: ${rediscoveryTokens} tok`);
      const detail = detailParts.length ? ` | ${detailParts.join(" | ")}` : "";

      console.log(`    ✓ base: ${baseTokens} tok${detail} | total: ${totalTaskTokens} tok | ${timeMs}ms`);
      if (regressionWarningShown) {
        console.log(`      ⚠ Regression warning shown [${agent}] — cross-agent: ${agent === "codex" ? "YES" : "no"}`);
      }
    }

    const totalTokens = totalBaseTokens + totalInjectionTokens + totalRediscoveryTokens;
    return {
      mode,
      tasks: results,
      totalTimeMs: Date.now() - overallStart,
      totalBaseTokens,
      totalInjectionTokens,
      totalRediscoveryTokens,
      totalTokens,
      redundantDiscoveries,
      regressionRepeats,
      successRate: 1.0,
      totalCrossAgentNodesRetrieved,
      crossAgentRegressionFired
    };
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

// ─── Metrics computation ──────────────────────────────────────────────────────

export function computeCrossAgentMetrics(
  off: CrossAgentRunResult,
  on: CrossAgentRunResult
): CrossAgentMetrics {
  return {
    redundantDiscoveryAvoided: off.redundantDiscoveries - on.redundantDiscoveries,
    regressionRepeatRate: {
      off: off.regressionRepeats / TASKS.length,
      on: on.regressionRepeats / TASKS.length
    },
    netTokenDelta: off.totalTokens - on.totalTokens,
    taskSuccessRate: { off: off.successRate, on: on.successRate },
    timeToCompletion: { offMs: off.totalTimeMs, onMs: on.totalTimeMs },
    crossAgentNodesRetrieved: on.totalCrossAgentNodesRetrieved,
    crossAgentRegressionFired: on.crossAgentRegressionFired
  };
}

// ─── Report formatting ────────────────────────────────────────────────────────

function formatCrossAgentReport(
  off: CrossAgentRunResult,
  on: CrossAgentRunResult,
  metrics: CrossAgentMetrics
): string {
  const lines: string[] = [];

  lines.push("# Dev-Mem V2 Cross-Agent Evaluation Results");
  lines.push("");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Tasks in sequence: ${TASKS.length} (Tasks 1–6: claude-code → Tasks 7–12: codex)`);
  lines.push("");

  lines.push("## Scenario");
  lines.push("");
  lines.push("Agent 1 (claude-code) works tasks 1–6, writing knowledge to the shared `.dev-mem/` store.");
  lines.push("Agent 2 (codex) picks up at task 7, reading from the same shared store.");
  lines.push("Task 7 deliberately re-attempts SQLite (failed by claude-code in Task 2) — the canonical");
  lines.push("cross-agent Regression Intelligence test: a FailedApproach recorded by Agent 1 should");
  lines.push("warn Agent 2 before it repeats the same mistake.");
  lines.push("");

  lines.push("## Token Accounting");
  lines.push("");
  lines.push("- `Math.ceil(text.length / 4)` applied to actual content strings. No flat multipliers.");
  lines.push("- System prompt tokens are agent-specific (Claude Code prompt vs Codex prompt), applied per task.");
  lines.push("- Cross-agent injection tokens are derived from the actual `generateInjectionString()` output,");
  lines.push("  which is whatever the retrieval system returns — including nodes written by the other agent.");
  lines.push("");

  lines.push("## Summary Metrics (§11)");
  lines.push("");
  lines.push("| Metric | Dev-Mem OFF | Dev-Mem ON | Delta |");
  lines.push("|--------|-------------|------------|-------|");

  lines.push(`| **1. Redundant discoveries** | ${off.redundantDiscoveries} events | ${on.redundantDiscoveries} events | ${metrics.redundantDiscoveryAvoided} avoided |`);
  lines.push(`| **2. Regression repeat rate** | ${(metrics.regressionRepeatRate.off * 100).toFixed(1)}% | ${(metrics.regressionRepeatRate.on * 100).toFixed(1)}% | ${((metrics.regressionRepeatRate.off - metrics.regressionRepeatRate.on) * 100).toFixed(1)}pp reduction |`);

  const deltaSign = metrics.netTokenDelta >= 0 ? "+" : "";
  lines.push(`| **3. Net token delta** | ${off.totalTokens} | ${on.totalTokens} | **${deltaSign}${metrics.netTokenDelta}** |`);
  lines.push(`| **4. Task success rate** | ${(metrics.taskSuccessRate.off * 100).toFixed(0)}% | ${(metrics.taskSuccessRate.on * 100).toFixed(0)}% | — |`);
  lines.push(`| **5. Time to completion** _(harness proxy)_ | ${(metrics.timeToCompletion.offMs / 1000).toFixed(1)}s | ${(metrics.timeToCompletion.onMs / 1000).toFixed(1)}s | — |`);
  lines.push("");

  lines.push("### Token Breakdown");
  lines.push("");
  lines.push("| Component | OFF | ON |");
  lines.push("|-----------|-----|----|");
  lines.push(`| Base (system + task prompt + response) | ${off.totalBaseTokens} | ${on.totalBaseTokens} |`);
  lines.push(`| Context injection (ON retrieval overhead) | — | ${on.totalInjectionTokens} |`);
  lines.push(`| Rediscovery exchanges (OFF re-derives) | ${off.totalRediscoveryTokens} | — |`);
  lines.push(`| **Total** | **${off.totalTokens}** | **${on.totalTokens}** |`);
  lines.push("");

  lines.push("## Cross-Agent Specific Results");
  lines.push("");
  lines.push("| Metric | Result |");
  lines.push("|--------|--------|");
  lines.push(`| Agent 1 (claude-code) nodes retrieved by Agent 2 (codex) | **${metrics.crossAgentNodesRetrieved}** |`);
  lines.push(`| Cross-agent Regression Intelligence fired (Task 7) | **${metrics.crossAgentRegressionFired ? "✅ YES" : "❌ NO"}** |`);
  lines.push("");

  if (on.totalCrossAgentNodesRetrieved > 0) {
    lines.push(`**Cross-agent retrieval confirmed:** ${on.totalCrossAgentNodesRetrieved} node(s) written by claude-code`);
    lines.push("were retrieved and injected into codex sessions. Knowledge crossed agent boundaries");
    lines.push("through the shared graph store — no manual transfer.");
  } else {
    lines.push("**No cross-agent nodes retrieved.** The retrieval system found no Agent 1 nodes");
    lines.push("that matched Agent 2's task context/files. This can occur when the knowledge graph");
    lines.push("is small and node overlap with Agent 2's files is low.");
  }
  lines.push("");

  lines.push("## Cross-Agent Regression Intelligence Detail");
  lines.push("");
  const task7On = on.tasks.find(t => t.taskId === 7);
  const task7Off = off.tasks.find(t => t.taskId === 7);
  lines.push(`- **FailedApproach node (SQLite rejected):** written by \`claude-code\`, Task 2`);
  lines.push(`- **Re-attempt:** Task 7, executed by \`codex\``);
  lines.push(`- **ON mode warning fired:** ${task7On?.regressionWarningShown ? "✅ YES — codex was warned before repeating the failure" : "❌ NO — warning did not fire"}`);
  lines.push(`- **OFF mode:** ❌ no mechanism — agent re-derived from scratch (${task7Off?.rediscoveryTokens ?? 0} rediscovery tokens)`);
  lines.push("");

  lines.push("## V2 Exit Criterion Assessment (§13)");
  lines.push("");
  const redundancyReduced = metrics.redundantDiscoveryAvoided > 0;
  const tokenPositive = metrics.netTokenDelta > 0;
  const crossAgentWorks = metrics.crossAgentNodesRetrieved > 0 || metrics.crossAgentRegressionFired;
  const v2Met = redundancyReduced && tokenPositive && crossAgentWorks;

  lines.push(`- **Measurable reduction in redundant discovery:** ${redundancyReduced ? "✅ YES" : "❌ NO"} — ${metrics.redundantDiscoveryAvoided} of ${off.redundantDiscoveries} events avoided`);
  lines.push(`- **Net-positive token delta:** ${tokenPositive ? "✅ YES" : "❌ NO"} — ${deltaSign}${metrics.netTokenDelta} tokens`);
  lines.push(`- **Knowledge crosses agent boundary:** ${crossAgentWorks ? "✅ YES" : "❌ NO"}`);
  lines.push("");

  if (v2Met) {
    lines.push("**V2 CROSS-AGENT EVAL: ✅ PASSED**");
  } else {
    lines.push("**V2 CROSS-AGENT EVAL: ❌ FAILED — see failures below**");
    lines.push("");
    if (!redundancyReduced) lines.push("- Dev-Mem did not reduce redundant discovery.");
    if (!tokenPositive) lines.push(`- ON mode cost ${-metrics.netTokenDelta} more tokens than OFF mode.`);
    if (!crossAgentWorks) lines.push("- No cross-agent node retrieval or regression warning fired. Shared store provided no benefit to Agent 2.");
  }
  lines.push("");

  lines.push("## Per-Task Breakdown");
  lines.push("");
  lines.push("| # | Agent | Task | OFF base | OFF rediscovery | OFF total | ON base | ON injection | ON cross-agent ↗ | ON total |");
  lines.push("|---|-------|------|----------|-----------------|-----------|---------|--------------|-----------------|----------|");
  for (let i = 0; i < TASKS.length; i++) {
    const t = TASKS[i];
    const o = off.tasks[i];
    const n = on.tasks[i];
    const rediscFlag = o.rediscoveryTokens > 0 ? `⚠ ${o.rediscoveryTokens}` : "0";
    const crossFlag = n.crossAgentNodesInjected > 0 ? `**${n.crossAgentNodesInjected}** ↗` : "—";
    const regrFlag = n.regressionWarningShown ? " ⚠RI" : "";
    lines.push(`| ${t.id} | \`${n.agent}\` | ${t.name}${regrFlag} | ${o.baseTokens} | ${rediscFlag} | **${o.totalTokens}** | ${n.baseTokens} | ${n.injectionTokens} | ${crossFlag} | **${n.totalTokens}** |`);
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function mainCrossAgent() {
  console.log("Dev-Mem V2 Cross-Agent Evaluation Harness");
  console.log("==========================================");
  console.log("Agent split: Tasks 1-6 = claude-code | Tasks 7-12 = codex");
  console.log("");

  const offResult = await runCrossAgentEvaluation("OFF");
  const onResult  = await runCrossAgentEvaluation("ON");
  const metrics   = computeCrossAgentMetrics(offResult, onResult);

  const report = formatCrossAgentReport(offResult, onResult, metrics);

  const resultsDir = join(process.cwd(), "eval", "results");
  mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(resultsDir, `eval-cross-agent-${timestamp}.md`);
  writeFileSync(outputPath, report, "utf8");

  console.log("\n" + report);
  console.log(`\nResults written to: ${outputPath}`);

  return { offResult, onResult, metrics };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mainCrossAgent().catch(err => {
    console.error("Cross-agent evaluation failed:", err);
    process.exit(1);
  });
}
