import { GraphStore } from "../graph/index.js";
import type { KnowledgeNode } from "../graph/types.js";

export interface RetrievalContext {
  projectRoot: string;
  budgetTokens?: number;
  /**
   * Optional free-text description of what the agent is about to work on
   * (e.g. from `dev-mem query "<text>"` or a task title from the hook payload).
   * When provided, relevance scoring uses keyword overlap against this text.
   * When absent, relevance falls back to file-path token overlap with currentFiles.
   */
  currentTask?: string;
  /** Files the agent is about to touch, used for both relevance fallback and
   *  graph-proximity scoring. */
  currentFiles?: string[];
}

export interface RetrievedNode extends KnowledgeNode {
  score: number;
  cost: number;
}

// ─── Token helpers ────────────────────────────────────────────────────────────

/** Approximate token cost: 4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Common English + code stopwords filtered from relevance tokenisation. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "but", "not", "all", "can", "its",
  "this", "that", "with", "from", "into", "have", "been", "will", "when",
  "then", "than", "some", "only", "must", "also", "more", "such", "very",
  "use", "used", "uses", "using", "via", "per", "any", "out", "get",
  "set", "new", "add", "added", "adds", "run", "runs", "ran",
]);

/**
 * Splits text into a normalised token set for overlap comparison.
 * Splits on non-word chars (handles both prose and file paths),
 * lowercases, drops stopwords and tokens shorter than 3 characters.
 */
function tokenise(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[\W_]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/**
 * Jaccard similarity between two token sets.
 * Returns 0 when both sets are empty.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ─── Scoring components ───────────────────────────────────────────────────────

/**
 * Relevance: how topically close is this node to what the agent is working on?
 *
 * Strategy (V1 — §13 scope: file/keyword-level, no embeddings):
 *
 *   1. If `currentTask` is provided: Jaccard(taskTokens, nodeTokens)
 *      where nodeTokens = tokenise(title + " " + content + " " + evidence.files.join(" "))
 *
 *   2. Else if `currentFiles` is non-empty: Jaccard on file-path tokens.
 *      Splits every file path on "/" and "." so that e.g. "src/server.js"
 *      contributes tokens {src, server, js}. This lets "src/server.js" in
 *      currentFiles match a node whose evidence.files includes "src/server.js"
 *      or "src/routes.js" (shared "src" token gives partial credit), while a
 *      node about "docs/architecture.md" still scores low.
 *
 *   3. Else: return 0.5 (neutral — no task context available; don't reward or
 *      penalise; let freshness/confidence decide ordering).
 *
 * Rationale for Jaccard: bounded [0,1], symmetric, size-invariant, zero
 * external dependencies. Appropriate for V1's "no embeddings" constraint.
 */
function calculateRelevance(
  node: KnowledgeNode,
  currentTask?: string,
  currentFiles?: string[],
): number {
  // Build the node's token representation: title + content + file paths
  const nodeText = [
    node.title,
    node.content,
    ...(node.evidence.files ?? []),
  ].join(" ");
  const nodeTokens = tokenise(nodeText);

  if (currentTask && currentTask.trim().length > 0) {
    // Strategy 1: task description text overlap
    const taskTokens = tokenise(currentTask);
    return jaccard(taskTokens, nodeTokens);
  }

  if (currentFiles && currentFiles.length > 0) {
    // Strategy 2: file-path token overlap
    const fileText = currentFiles.join(" ");
    const fileTokens = tokenise(fileText);
    const nodeFileTokens = tokenise((node.evidence.files ?? []).join(" "));
    // Combine: overlap between current file tokens and node's file tokens
    return jaccard(fileTokens, nodeFileTokens);
  }

  // Strategy 3: no context — neutral score
  return 0.5;
}

function calculateFreshness(timestamp: string): number {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  // Halves every 7 days: exp(-ln(2)/7 * days)
  return Math.exp(-(Math.LN2 / 7) * ageDays);
}

function calculateGraphProximity(node: KnowledgeNode, currentFiles?: string[]): number {
  if (!currentFiles || currentFiles.length === 0) return 0.5; // neutral, no signal
  if (!node.evidence.files || node.evidence.files.length === 0) return 0.0;

  // V1 approximation (§13): exact file-name overlap.
  // This is a distinct signal from relevance: a node must cite one of the
  // exact files being touched to get full proximity credit, whereas relevance
  // uses token overlap which gives partial credit for related files.
  const norm = (p: string) => p.replace(/\\/g, "/");
  const currentSet = new Set(currentFiles.map(norm));
  const nodeFiles = node.evidence.files.map(norm);
  const matched = nodeFiles.filter(f => currentSet.has(f)).length;
  return matched > 0 ? matched / nodeFiles.length : 0.0;
}

// ─── Composite weights ────────────────────────────────────────────────────────
//
// Previous weights: relevance 0.20, freshness 0.30, confidence 0.30, proximity 0.20
// Those were set when relevance was a hard-coded constant (1.0), making the
// 0.20 weight meaningless — every node received the same 0.20 contribution.
//
// New weights now that relevance actually discriminates (0.0–1.0):
//
//   relevance   0.35  — raised: topical match is the primary filter for whether
//                        a node is worth injecting at all. A node about an
//                        unrelated subsystem should be suppressible regardless of
//                        how fresh or confident it is.
//
//   freshness   0.25  — reduced from 0.30: freshness is useful for tie-breaking
//                        between two equally relevant nodes, but should not
//                        outweigh topical match.
//
//   confidence  0.20  — unchanged: extraction confidence is a secondary quality
//                        signal, not a relevance signal.
//
//   proximity   0.20  — unchanged: exact-file match is a strong but narrow
//                        signal (fires only for nodes about the exact files
//                        being touched). Leaving at 0.20 keeps it as a
//                        tie-breaker / booster without dominating.
//
// Sum = 1.00.

const W_RELEVANCE  = 0.35;
const W_FRESHNESS  = 0.25;
const W_CONFIDENCE = 0.20;
const W_PROXIMITY  = 0.20;

// ─── Adaptive budget default ──────────────────────────────────────────────────
//
// A flat ceiling (e.g. 2000 tokens) makes relevance filtering a no-op on small
// graphs: if the entire graph costs less than the budget, every node is always
// injected regardless of its relevance score.
//
// The adaptive formula keeps the budget proportional to graph size so that
// roughly half the graph is always subject to filtering:
//
//   budget = clamp(nodeCount × TOKEN_BUDGET_PER_NODE, MIN_BUDGET, MAX_BUDGET)
//
//   TOKEN_BUDGET_PER_NODE = 18  (≈ half the ~35-token cost of one formatted node)
//   MIN_BUDGET            = 80  (floor: always allow at least 2 nodes)
//   MAX_BUDGET            = 2000 (ceiling: unchanged for large mature graphs)
//
// Examples:
//   5 nodes  → 5×18 = 90 tok  (budget fits ~2–3 nodes; relevance picks the best)
//   12 nodes → 12×18 = 216 tok (budget fits ~6 nodes; half the graph is filtered)
//   50 nodes → 50×18 = 900 tok
//   120 nodes → capped at 2000 tok
//
// Callers may still pass an explicit budgetTokens to override this for specific
// use cases (e.g. the query CLI command uses a wider budget when the user asks
// for a full dump).

const TOKEN_BUDGET_PER_NODE = 18;
const MIN_BUDGET = 80;
const MAX_BUDGET = 2000;

function adaptiveBudget(nodeCount: number): number {
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, nodeCount * TOKEN_BUDGET_PER_NODE));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function retrieveContext(context: RetrievalContext): RetrievedNode[] {
  const { projectRoot, currentTask, currentFiles } = context;
  const store = new GraphStore({ projectRoot });

  let nodes: KnowledgeNode[] = [];
  try {
    nodes = store.queryAllNodes();
  } finally {
    store.close();
  }

  // Use caller-supplied budget if provided; otherwise derive it adaptively so
  // that relevance filtering has real selection pressure at any graph size.
  const budgetTokens = context.budgetTokens ?? adaptiveBudget(nodes.length);

  // Score every candidate node
  const scoredNodes: RetrievedNode[] = nodes.map(node => {
    const relevance  = calculateRelevance(node, currentTask, currentFiles);
    const freshness  = calculateFreshness(node.updated_at || node.created_at);
    const confidence = node.evidence.confidence;
    const proximity  = calculateGraphProximity(node, currentFiles);

    const score =
      W_RELEVANCE  * relevance  +
      W_FRESHNESS  * freshness  +
      W_CONFIDENCE * confidence +
      W_PROXIMITY  * proximity;

    const injectionText = formatNode(node);
    const cost = estimateTokens(injectionText);

    return { ...node, score, cost };
  });

  // Descending score order
  scoredNodes.sort((a, b) => b.score - a.score);

  // Budget-constrained greedy selection (§8: 0/1 knapsack, exact for small N)
  const selected: RetrievedNode[] = [];
  let spent = 0;
  for (const node of scoredNodes) {
    if (spent + node.cost <= budgetTokens) {
      selected.push(node);
      spent += node.cost;
    }
  }

  return selected;
}

export function formatNode(node: KnowledgeNode): string {
  const ageMs = Date.now() - new Date(node.updated_at || node.created_at).getTime();
  const ageDays = Math.round(Math.max(0, ageMs / (1000 * 60 * 60 * 24)));
  const ageStr = ageDays === 0 ? "today" : `${ageDays} days ago`;

  // "FailedApproach" → "FAILED APPROACH"
  const typeDisplay = node.type.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();

  let evidenceStr = `Evidence: commit ${node.evidence.commit.substring(0, 7)}, ${node.evidence.files.join(", ")}`;
  if (node.evidence.test_ref) {
    evidenceStr += `, test_ref: ${node.evidence.test_ref}`;
  }

  return `[${typeDisplay}] (confidence: ${node.evidence.confidence.toFixed(2)}, ${node.lifecycle_state} ${ageStr})
${node.title}
${evidenceStr}`;
}

export function generateInjectionString(nodes: KnowledgeNode[]): string {
  if (nodes.length === 0) return "";

  const formatted = nodes.map(formatNode).join("\n\n");
  return `<dev_mem_context>
Relevant context from previous development sessions:

${formatted}
</dev_mem_context>`;
}

// ─── Exported internals for testing ──────────────────────────────────────────

export { calculateRelevance, calculateFreshness, calculateGraphProximity, jaccard, tokenise, adaptiveBudget };
