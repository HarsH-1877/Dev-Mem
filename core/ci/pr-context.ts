import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { sanitizeText } from "../capture/sanitize.js";
import { GraphStore } from "../graph/index.js";
import { checkRegressionRisk, type RegressionMatch } from "../regression/index.js";
import { retrieveContext, type RetrievedNode } from "../retrieval/index.js";
import { getSharedGraphPath, importSharedGraph, syncSharedGraph } from "../sync/index.js";

export interface PrContextOptions {
  changedFiles?: string[];
  baseRef?: string;
  headRef?: string;
  title?: string;
  verifyOnMerge?: boolean;
  maxNodes?: number;
}

export interface PrContextResult {
  changedFiles: string[];
  regressionWarnings: RegressionMatch[];
  relevantNodes: RetrievedNode[];
  verifiedNodeIds: string[];
  hasContent: boolean;
  markdown: string;
}

const COMMENT_MARKER = "<!-- dev-mem-pr-context -->";
const VERIFY_ELIGIBLE_TYPES = new Set(["Decision", "Constraint", "Convention", "Discovery"]);

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function detectChangedFilesFromGit(
  projectRoot: string,
  baseRef = "origin/main",
  headRef = "HEAD",
): string[] {
  const attempts = [
    ["diff", "--name-only", `${baseRef}...${headRef}`],
    ["diff", "--name-only", `${headRef}~1`, headRef],
    ["diff", "--name-only", "--cached"],
  ];

  for (const args of attempts) {
    try {
      const out = execFileSync("git", args, {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (out) {
        return out
          .split(/\r?\n/)
          .map((l) => normPath(l.trim()))
          .filter(Boolean);
      }
    } catch {
      // try next fallback
    }
  }
  return [];
}

function buildPrCommentMarkdown(
  changedFiles: string[],
  warnings: RegressionMatch[],
  nodes: RetrievedNode[],
  verifiedIds: string[],
): string {
  if (warnings.length === 0 && nodes.length === 0 && verifiedIds.length === 0) {
    return "";
  }

  const lines: string[] = [
    COMMENT_MARKER,
    "## Dev-Mem PR Engineering Context",
    "",
  ];

  if (warnings.length > 0) {
    lines.push("### ⚠ Regression Intelligence Warnings");
    lines.push("");
    for (const match of warnings) {
      const { node, overlapRatio } = match;
      const files = node.evidence.files.slice(0, 4).join(", ");
      lines.push(
        `- **[${node.id.slice(0, 8)}]** **${sanitizeText(node.title).trim()}** *(file overlap: ${Math.round(overlapRatio * 100)}%, confidence: ${node.evidence.confidence.toFixed(2)}, files: \`${files}\`)*`,
      );
      if (node.content) {
        lines.push(`  - ${sanitizeText(node.content).replace(/\s+/g, " ").trim()}`);
      }
    }
    lines.push("");
  }

  const warningIds = new Set(warnings.map((w) => w.node.id));
  const nonWarningNodes = nodes.filter((n) => !warningIds.has(n.id));
  if (nonWarningNodes.length > 0) {
    lines.push("### Relevant Project Constraints & Decisions");
    lines.push("");
    for (const node of nonWarningNodes) {
      const files = node.evidence.files.slice(0, 3).join(", ");
      const verifiedTag = verifiedIds.includes(node.id) ? "Verified on merge" : node.lifecycle_state;
      lines.push(
        `- **[${node.type}]** **${sanitizeText(node.title).trim()}** *(${verifiedTag}${files ? ` · \`${files}\`` : ""})*`,
      );
      if (node.content) {
        lines.push(`  - ${sanitizeText(node.content).replace(/\s+/g, " ").trim()}`);
      }
    }
    lines.push("");
  }

  if (verifiedIds.length > 0) {
    lines.push(
      `_Auto-verified ${verifiedIds.length} node(s) referencing ${changedFiles.length} changed file(s) on green merge._`,
    );
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Evaluates Dev-Mem context and regression warnings for a Pull Request or merge commit.
 * Pure local/offline execution (imports `.dev-mem/shared.jsonl` on fresh CI runners).
 */
export function runPrContext(
  projectRoot: string,
  options: PrContextOptions = {},
): PrContextResult {
  if (existsSync(getSharedGraphPath(projectRoot))) {
    importSharedGraph(projectRoot);
  }

  const changedFiles = (
    options.changedFiles && options.changedFiles.length > 0
      ? options.changedFiles.map(normPath)
      : detectChangedFilesFromGit(projectRoot, options.baseRef, options.headRef)
  ).filter(Boolean);

  const currentTask = options.title?.trim() || undefined;
  const changedSet = new Set(changedFiles);

  const verifiedNodeIds: string[] = [];
  if (options.verifyOnMerge && changedSet.size > 0) {
    const store = new GraphStore({ projectRoot });
    try {
      const candidates = store.queryAllNodes();
      for (const node of candidates) {
        if (!VERIFY_ELIGIBLE_TYPES.has(node.type)) continue;
        if (node.lifecycle_state !== "observed" && node.lifecycle_state !== "active") continue;
        if (node.evidence.grounded === false) continue;

        const touchesChanged = (node.evidence.files ?? []).some((f) => changedSet.has(normPath(f)));
        if (touchesChanged) {
          store.transitionLifecycleState(node.id, "verified");
          verifiedNodeIds.push(node.id);
        }
      }
    } finally {
      store.close();
    }
    if (verifiedNodeIds.length > 0) {
      syncSharedGraph(projectRoot);
    }
  }

  const regressionWarnings =
    changedFiles.length > 0
      ? checkRegressionRisk({
          projectRoot,
          currentFiles: changedFiles,
          currentTask,
          confidenceThreshold: 0.6,
        })
      : [];

  const maxNodes = options.maxNodes ?? 8;
  const relevantNodes =
    changedFiles.length > 0 || currentTask
      ? retrieveContext({
          projectRoot,
          currentFiles: changedFiles,
          currentTask,
          budgetTokens: 1500,
          minRelevance: currentTask && changedFiles.length === 0 ? 0.08 : undefined,
        }).slice(0, maxNodes)
      : [];

  const markdown = buildPrCommentMarkdown(
    changedFiles,
    regressionWarnings,
    relevantNodes,
    verifiedNodeIds,
  );

  return {
    changedFiles,
    regressionWarnings,
    relevantNodes,
    verifiedNodeIds,
    hasContent: markdown.length > 0,
    markdown,
  };
}
