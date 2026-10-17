import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GraphStore, type KnowledgeEdge, type KnowledgeNode } from "../graph/index.js";
import { ensureLocalDataDir, getSharedGraphPath, SHARED_GRAPH_FILENAME } from "../local-data.js";

export { SHARED_GRAPH_FILENAME, getSharedGraphPath };

interface SharedNodeRecord {
  record_type: "node";
  node: KnowledgeNode;
}

interface SharedEdgeRecord {
  record_type: "edge";
  edge: KnowledgeEdge;
}

type SharedRecord = SharedNodeRecord | SharedEdgeRecord;

/**
 * Exports all curated (`active` and `verified`) knowledge nodes and their
 * connecting edges to `.dev-mem/shared.jsonl`, sorted deterministically by ID
 * so git diffs and merges are clean.
 */
export function exportSharedGraph(projectRoot: string): {
  exportedNodes: number;
  exportedEdges: number;
  path: string;
} {
  ensureLocalDataDir(projectRoot);
  const store = new GraphStore({ projectRoot });
  try {
    const shareableNodes = store
      .queryAllNodes()
      .filter((n) => n.lifecycle_state === "active" || n.lifecycle_state === "verified")
      .sort((a, b) => a.id.localeCompare(b.id));

    const nodeIdSet = new Set(shareableNodes.map((n) => n.id));
    const shareableEdges = store
      .listEdges()
      .filter((e) => nodeIdSet.has(e.from_id) && nodeIdSet.has(e.to_id))
      .sort((a, b) => a.id.localeCompare(b.id));

    const lines: string[] = [
      ...shareableNodes.map((node) => JSON.stringify({ record_type: "node", node } satisfies SharedNodeRecord)),
      ...shareableEdges.map((edge) => JSON.stringify({ record_type: "edge", edge } satisfies SharedEdgeRecord)),
    ];

    const outPath = getSharedGraphPath(projectRoot);
    writeFileSync(outPath, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
    return {
      exportedNodes: shareableNodes.length,
      exportedEdges: shareableEdges.length,
      path: outPath,
    };
  } finally {
    store.close();
  }
}

/**
 * Idempotently imports nodes and edges from `.dev-mem/shared.jsonl` into the
 * local SQLite graph store. Safe to call on SessionStart or via `dev-memo sync`.
 */
export function importSharedGraph(projectRoot: string): {
  importedNodes: number;
  updatedNodes: number;
  importedEdges: number;
} {
  const sharedPath = getSharedGraphPath(projectRoot);
  if (!existsSync(sharedPath)) {
    return { importedNodes: 0, updatedNodes: 0, importedEdges: 0 };
  }

  const raw = readFileSync(sharedPath, "utf8").trim();
  if (!raw) {
    return { importedNodes: 0, updatedNodes: 0, importedEdges: 0 };
  }

  let importedNodes = 0;
  let updatedNodes = 0;
  let importedEdges = 0;

  const store = new GraphStore({ projectRoot });
  try {
    const existingEdges = new Set(store.listEdges().map((e) => e.id));

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let rec: SharedRecord;
      try {
        rec = JSON.parse(line) as SharedRecord;
      } catch {
        continue;
      }

      if (rec.record_type === "node" && rec.node?.id) {
        const existing = store.getNode(rec.node.id);
        if (!existing) {
          try {
            store.createNode({
              id: rec.node.id,
              type: rec.node.type,
              title: rec.node.title,
              content: rec.node.content,
              lifecycle_state: rec.node.lifecycle_state,
              evidence: rec.node.evidence,
            });
            importedNodes++;
          } catch {
            // Skip invalid node
          }
        } else if (
          existing.lifecycle_state === "observed" &&
          (rec.node.lifecycle_state === "active" || rec.node.lifecycle_state === "verified")
        ) {
          try {
            store.transitionLifecycleState(existing.id, rec.node.lifecycle_state);
            updatedNodes++;
          } catch {}
        }
      } else if (rec.record_type === "edge" && rec.edge?.id) {
        if (!existingEdges.has(rec.edge.id)) {
          try {
            store.createEdge({
              id: rec.edge.id,
              from_id: rec.edge.from_id,
              to_id: rec.edge.to_id,
              type: rec.edge.type,
            });
            existingEdges.add(rec.edge.id);
            importedEdges++;
          } catch {}
        }
      }
    }
  } finally {
    store.close();
  }

  return { importedNodes, updatedNodes, importedEdges };
}

/**
 * Bidirectional sync: first imports any teammate updates from `.dev-mem/shared.jsonl`,
 * then exports all local `active` and `verified` nodes back to `.dev-mem/shared.jsonl`.
 */
export function syncSharedGraph(projectRoot: string): {
  importedNodes: number;
  updatedNodes: number;
  exportedNodes: number;
} {
  const imp = importSharedGraph(projectRoot);
  const exp = exportSharedGraph(projectRoot);
  return {
    importedNodes: imp.importedNodes,
    updatedNodes: imp.updatedNodes,
    exportedNodes: exp.exportedNodes,
  };
}
