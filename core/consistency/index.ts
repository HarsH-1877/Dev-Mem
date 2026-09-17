/**
 * Lightweight Consistency Check (§8.2)
 *
 * Two narrow, scoped checks only — per spec's explicit scope limit:
 *
 * 1. `checkContradictions` — rule-based detection of semantic conflicts between
 *    a newly proposed node and existing active nodes touching the same files.
 *    When a conflict is found a `contradicts` edge is created in the graph.
 *    Rule: a new Decision/Constraint that shares files with an existing
 *    Decision/Constraint of the opposite polarity (or identical title tokens).
 *    We use an LLM-assisted check during extraction rather than pure heuristics
 *    because keyword matching is brittle for semantic contradictions (e.g.
 *    "use X" vs "don't use X" requires understanding negation). The LLM call is
 *    extremely cheap (single yes/no answer) and reuses the existing API key.
 *    Fallback: if no API key, use a simple title-overlap heuristic.
 *
 * 2. `checkStaleness` — walks all non-stale, non-superseded nodes and marks any
 *    whose cited files no longer exist on disk as `stale`.
 *    Existence check only — no semantic re-validation (§8.2 explicit scope limit).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { GraphStore } from "../graph/index.js";
import type { KnowledgeNode } from "../graph/types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Node types that can meaningfully contradict each other
const CONTRADICTION_TYPES = new Set(["Decision", "Constraint", "Convention"]);

// ─── Contradiction detection ───────────────────────────────────────────────

export interface ContradictionResult {
  /** IDs of `contradicts` edges created */
  edgesCreated: string[];
  /** Human-readable descriptions of conflicts found */
  conflicts: string[];
}

/**
 * Checks whether `newNode` contradicts any existing active nodes.
 * If a contradiction is detected, creates a `contradicts` edge.
 *
 * Does not throw — errors log and return empty result.
 */
export async function checkContradictions(
  newNode: KnowledgeNode,
  projectRoot: string,
  apiKey?: string,
  dbPath?: string
): Promise<ContradictionResult> {
  const result: ContradictionResult = { edgesCreated: [], conflicts: [] };

  // Only check types that can meaningfully contradict each other
  if (!CONTRADICTION_TYPES.has(newNode.type)) return result;

  const store = new GraphStore({ projectRoot, dbPath, ephemeral: dbPath !== undefined });
  try {
    const allNodes = store.queryAllNodes();

    // Candidate nodes: same contradiction-eligible type, overlapping files,
    // not the new node itself, not already stale/superseded.
    const candidates = allNodes.filter((n) => {
      if (n.id === newNode.id) return false;
      if (!CONTRADICTION_TYPES.has(n.type)) return false;
      if (n.lifecycle_state === "stale" || n.lifecycle_state === "superseded") return false;

      // File overlap check
      const sharedFiles = n.evidence.files.filter((f) =>
        newNode.evidence.files.includes(f)
      );
      return sharedFiles.length > 0;
    });

    if (candidates.length === 0) return result;

    // Check each candidate for contradiction
    for (const candidate of candidates) {
      const contradicts = await detectContradiction(newNode, candidate, apiKey);
      if (contradicts) {
        try {
          const edge = store.createEdge({
            from_id: newNode.id,
            to_id: candidate.id,
            type: "contradicts",
          });
          result.edgesCreated.push(edge.id);
          result.conflicts.push(
            `"${newNode.title}" contradicts "${candidate.title}"`
          );
          console.warn(
            `[dev-mem] Contradiction detected: "${newNode.title}" ↔ "${candidate.title}"`
          );
        } catch (edgeErr: any) {
          console.error(`[dev-mem] Failed to create contradicts edge: ${edgeErr.message}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[dev-mem] Contradiction check error: ${err.message}`);
  } finally {
    store.close();
  }

  return result;
}

/**
 * Determines whether two nodes contradict each other.
 *
 * Strategy (in order of availability):
 * 1. LLM yes/no check (cheap single-token answer) — accurate for semantic negation
 * 2. Title-token heuristic fallback — catches obvious structural conflicts
 */
async function detectContradiction(
  nodeA: KnowledgeNode,
  nodeB: KnowledgeNode,
  apiKey?: string
): Promise<boolean> {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;

  if (key) {
    return detectContradictionViaLlm(nodeA, nodeB, key);
  }

  // Fallback: structural heuristic
  return detectContradictionHeuristic(nodeA, nodeB);
}

async function detectContradictionViaLlm(
  nodeA: KnowledgeNode,
  nodeB: KnowledgeNode,
  apiKey: string
): Promise<boolean> {
  try {
    const prompt =
      `Do these two development knowledge statements directly contradict each other? ` +
      `Answer with only "YES" or "NO".\n\n` +
      `Statement A: ${nodeA.title}\n` +
      `Statement B: ${nodeB.title}`;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 5,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) return false;

    const data = (await response.json()) as any;
    const text: string = data?.content?.[0]?.text?.trim().toUpperCase() ?? "";
    return text.startsWith("YES");
  } catch {
    // If LLM call fails, fall back to heuristic silently
    return detectContradictionHeuristic(nodeA, nodeB);
  }
}

/**
 * Simple heuristic: checks for negation tokens in one title that negate
 * the key noun/verb tokens of the other. Covers "use X" vs "don't use X",
 * "avoid X" vs "prefer X", etc.
 */
function detectContradictionHeuristic(
  nodeA: KnowledgeNode,
  nodeB: KnowledgeNode
): boolean {
  const negationPrefixes = [
    /\bdon'?t\s+use\b/i,
    /\bavoid\b/i,
    /\bnever\b/i,
    /\bdo not\b/i,
    /\bprohibit/i,
    /\bforbid/i,
  ];
  const affirmativePrefixes = [
    /\buse\b/i,
    /\bprefer\b/i,
    /\balways\b/i,
    /\brequire/i,
    /\bmust\b/i,
  ];

  const aHasNegation = negationPrefixes.some((r) => r.test(nodeA.title));
  const bHasNegation = negationPrefixes.some((r) => r.test(nodeB.title));
  const aHasAffirm = affirmativePrefixes.some((r) => r.test(nodeA.title));
  const bHasAffirm = affirmativePrefixes.some((r) => r.test(nodeB.title));

  // Only flag if one has affirmation and the other negation for the same key noun
  if (!((aHasNegation && bHasAffirm) || (aHasAffirm && bHasNegation))) {
    return false;
  }

  // Extract key nouns (non-stopword tokens ≥4 chars)
  const stopwords = new Set(["with", "that", "this", "from", "into", "have", "been", "will", "when", "then", "than", "some", "must", "only"]);
  const tokenize = (s: string) =>
    s.toLowerCase().split(/\W+/).filter((t) => t.length >= 4 && !stopwords.has(t));

  const tokensA = new Set(tokenize(nodeA.title));
  const tokensB = new Set(tokenize(nodeB.title));
  const overlap = [...tokensA].filter((t) => tokensB.has(t));

  return overlap.length >= 1;
}

// ─── Staleness detection ───────────────────────────────────────────────────

export interface StalenessResult {
  /** IDs of nodes transitioned to `stale` */
  markedStale: string[];
  /** Human-readable descriptions */
  details: string[];
}

/**
 * Walks all active/verified/observed nodes and marks stale any whose
 * cited files no longer exist on disk.
 *
 * Existence check only — no deep semantic re-validation (§8.2 scope limit).
 * Does not throw.
 */
export function checkStaleness(
  projectRoot: string,
  dbPath?: string,
  excludeNodeIds?: string[]
): StalenessResult {
  const result: StalenessResult = { markedStale: [], details: [] };
  const store = new GraphStore({ projectRoot, dbPath, ephemeral: dbPath !== undefined });
  const excludeSet = new Set(excludeNodeIds || []);

  try {
    const allNodes = store.queryAllNodes();

    for (const node of allNodes) {
      if (excludeSet.has(node.id)) {
        continue;
      }
      // Only check nodes that can become stale
      if (
        node.lifecycle_state === "stale" ||
        node.lifecycle_state === "superseded"
      ) {
        continue;
      }

      // Check that at least one cited file still exists.
      // If ALL files are missing → stale. If at least one exists → still valid.
      const allMissing = node.evidence.files.every(
        (f) => !existsSync(join(projectRoot, f))
      );

      if (allMissing) {
        try {
          store.transitionLifecycleState(node.id, "stale");
          result.markedStale.push(node.id);
          const detail =
            `Node "${node.title}" marked stale — all cited files missing: ` +
            node.evidence.files.join(", ");
          result.details.push(detail);
          console.warn(`[dev-mem] Staleness: ${detail}`);
        } catch (transitionErr: any) {
          console.error(
            `[dev-mem] Failed to mark node stale: ${transitionErr.message}`
          );
        }
      }
    }
  } catch (err: any) {
    console.error(`[dev-mem] Staleness check error: ${err.message}`);
  } finally {
    store.close();
  }

  return result;
}
