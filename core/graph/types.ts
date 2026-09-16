import type { LifecycleState } from "../lifecycle/index.js";

export const NODE_TYPES = [
  "Decision",
  "FailedApproach",
  "Constraint",
  "Discovery",
  "Convention",
  "OpenIssue",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  "supersedes",
  "contradicts",
  "depends-on",
  "discovered-from",
  "resolves",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

/**
 * Evidence schema — field names and types match spec §5.4 exactly.
 */
export interface Evidence {
  commit: string;
  files: string[];
  diff_ref?: string;
  test_ref?: string;
  symbols?: string[];
  session_id: string;
  agent: string;
  timestamp: string;
  confidence: number;
}

export interface KnowledgeNode {
  id: string;
  type: NodeType;
  title: string;
  content: string;
  lifecycle_state: LifecycleState;
  evidence: Evidence;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeEdge {
  id: string;
  from_id: string;
  to_id: string;
  type: EdgeType;
  created_at: string;
}

export interface LifecycleHistoryEntry {
  id: number;
  node_id: string;
  from_state: LifecycleState | null;
  to_state: LifecycleState;
  timestamp: string;
}

export interface CreateNodeInput {
  type: NodeType;
  title: string;
  content?: string;
  evidence: Evidence;
  lifecycle_state?: LifecycleState;
  id?: string;
}

export interface CreateEdgeInput {
  from_id: string;
  to_id: string;
  type: EdgeType;
  id?: string;
}

export interface GraphTraversalHop {
  id: string;
  depth: number;
}
