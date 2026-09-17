/**
 * Regression Intelligence (§8.1)
 *
 * Actively checks the current session's touched files against stored
 * FailedApproach nodes. When a match clears the confidence threshold,
 * returns a structured warning block that the hook injects before normal
 * retrieval context so the agent sees it prominently.
 */

import { GraphStore } from "../graph/index.js";
import type { KnowledgeNode } from "../graph/types.js";

export interface RegressionCheckContext {
  projectRoot: string;
  /** Files the agent is about to touch / is currently working in. */
  currentFiles: string[];
  /** 0–1 threshold; matches below this are silently skipped. Default 0.6. */
  confidenceThreshold?: number;
  /** Override DB path (for testing). */
  dbPath?: string;
}

export interface RegressionMatch {
  node: KnowledgeNode;
  /** Overlap ratio: matched_files / node.evidence.files.length */
  overlapRatio: number;
}

/**
 * Returns all FailedApproach nodes whose cited files overlap with
 * `currentFiles`, above `confidenceThreshold`.
 *
 * Does not throw — errors log and return [].
 */
export function checkRegressionRisk(ctx: RegressionCheckContext): RegressionMatch[] {
  const { projectRoot, currentFiles, confidenceThreshold = 0.6, dbPath } = ctx;

  if (currentFiles.length === 0) return [];

  const store = new GraphStore({ projectRoot, dbPath, ephemeral: dbPath === ":memory:" });
  let failedNodes: KnowledgeNode[] = [];
  try {
    failedNodes = store.queryByType("FailedApproach");
  } catch (err) {
    console.error("[dev-mem] regression check error:", err);
    return [];
  } finally {
    store.close();
  }

  const matches: RegressionMatch[] = [];
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedCurrentFiles = new Set(currentFiles.map(norm));

  for (const node of failedNodes) {
    // Skip nodes that are superseded or stale — already resolved.
    if (node.lifecycle_state === "superseded" || node.lifecycle_state === "stale") {
      continue;
    }

    if (node.evidence.confidence < confidenceThreshold) continue;

    const nodeFiles = (node.evidence.files || []).map(norm);
    const matchedFiles = nodeFiles.filter((f) => normalizedCurrentFiles.has(f));
    const overlapRatio = nodeFiles.length > 0 ? matchedFiles.length / nodeFiles.length : 0;

    if (matchedFiles.length > 0) {
      matches.push({ node, overlapRatio });
    }
  }

  // Sort: higher overlap first, then higher confidence
  matches.sort((a, b) => {
    const overlapDiff = b.overlapRatio - a.overlapRatio;
    if (Math.abs(overlapDiff) > 0.01) return overlapDiff;
    return b.node.evidence.confidence - a.node.evidence.confidence;
  });

  return matches;
}

/**
 * Formats regression matches into the §8.1 / §9 warning block.
 *
 * Returns empty string when matches is empty.
 */
export function formatRegressionWarning(matches: RegressionMatch[]): string {
  if (matches.length === 0) return "";

  const lines: string[] = [
    "<dev_mem_regression_warning>",
    "⚠ Regression Intelligence — known failed approaches overlap with current files:",
    "",
  ];

  for (const { node, overlapRatio } of matches) {
    const ageMs = Date.now() - new Date(node.updated_at || node.created_at).getTime();
    const ageDays = Math.round(Math.max(0, ageMs / (1000 * 60 * 60 * 24)));
    const ageStr = ageDays === 0 ? "today" : `${ageDays} days ago`;

    // spec §8.1 example format
    lines.push(`⚠ A similar approach was already tried and failed:`);
    lines.push(`"${node.title}"`);
    lines.push(
      `(session: ${node.evidence.session_id}, commit: ${node.evidence.commit.substring(0, 7)}, ` +
      `confidence: ${node.evidence.confidence.toFixed(2)}, ${ageStr}, file overlap: ${Math.round(overlapRatio * 100)}%)`
    );

    if (node.content) {
      lines.push(`Detail: ${node.content}`);
    }

    lines.push(`Files: ${node.evidence.files.join(", ")}`);
    lines.push("");
  }

  lines.push("</dev_mem_regression_warning>");
  return lines.join("\n");
}
