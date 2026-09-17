import { GraphStore } from "../graph/index.js";
import type { KnowledgeNode } from "../graph/types.js";

export interface RetrievalContext {
  projectRoot: string;
  budgetTokens?: number;
  currentTask?: string;
  currentFiles?: string[];
}

export interface RetrievedNode extends KnowledgeNode {
  score: number;
  cost: number;
}

// Approximate token cost: 4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function calculateFreshness(timestamp: string): number {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  // Decay function: halves every ~7 days. exp(-ln(2)/7 * days)
  return Math.exp(-(Math.LN2 / 7) * ageDays);
}

function calculateGraphProximity(node: KnowledgeNode, currentFiles?: string[]): number {
  if (!currentFiles || currentFiles.length === 0) return 1.0;
  if (!node.evidence.files || node.evidence.files.length === 0) return 0.0;
  
  // V1 approximation (§13): Simple shared file overlap
  const intersection = node.evidence.files.filter(f => currentFiles.includes(f));
  return intersection.length > 0 ? 1.0 : 0.0;
}

export function retrieveContext(context: RetrievalContext): RetrievedNode[] {
  const { projectRoot, budgetTokens = 2000, currentFiles } = context;
  const store = new GraphStore({ projectRoot });
  
  // Weights (configurable in later milestones)
  const w1 = 0.2; // relevance (1.0 for now)
  const w2 = 0.3; // freshness
  const w3 = 0.3; // confidence
  const w4 = 0.2; // graph proximity

  let nodes: KnowledgeNode[] = [];
  try {
    // M4: Fetch all nodes since we don't have vector DB filtering in V1
    nodes = store.queryAllNodes();
  } finally {
    store.close();
  }

  // 1. Score nodes
  const scoredNodes: RetrievedNode[] = nodes.map(node => {
    const relevance = 1.0; // V1 static relevance until embeddings are implemented
    const freshness = calculateFreshness(node.updated_at || node.created_at);
    const confidence = node.evidence.confidence;
    const proximity = calculateGraphProximity(node, currentFiles);
    
    const score = (w1 * relevance) + (w2 * freshness) + (w3 * confidence) + (w4 * proximity);
    
    // Cost: Base injection format cost
    const injectionText = formatNode(node);
    const cost = estimateTokens(injectionText);

    return { ...node, score, cost };
  });

  // 2. Sort by score descending
  scoredNodes.sort((a, b) => b.score - a.score);

  // 3. Budget-constrained greedy selection
  const selected: RetrievedNode[] = [];
  let currentCost = 0;

  for (const node of scoredNodes) {
    if (currentCost + node.cost <= budgetTokens) {
      selected.push(node);
      currentCost += node.cost;
    }
  }

  return selected;
}

export function formatNode(node: KnowledgeNode): string {
  const ageMs = Date.now() - new Date(node.updated_at || node.created_at).getTime();
  const ageDays = Math.round(Math.max(0, ageMs / (1000 * 60 * 60 * 24)));
  const ageStr = ageDays === 0 ? "today" : `${ageDays} days ago`;
  
  // Format PascalCase type names: "FailedApproach" -> "FAILED APPROACH", "Decision" -> "DECISION"
  const typeDisplay = node.type.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
  
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
