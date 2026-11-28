import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  assertTransition,
  canTransition,
  isLifecycleState,
  type LifecycleState,
} from "../lifecycle/index.js";
import { ensureLocalDataDir, getGraphDbPath } from "../local-data.js";
import { normalizeEvidence } from "./evidence.js";
import {
  SCHEMA_SQL,
  WALK_INCOMING_SQL,
  WALK_OUTGOING_SQL,
} from "./schema.js";
import type {
  CreateEdgeInput,
  CreateNodeInput,
  EdgeType,
  GraphTraversalHop,
  KnowledgeEdge,
  KnowledgeNode,
  LifecycleHistoryEntry,
  NodeType,
  UpdateNodeInput,
} from "./types.js";
import { EDGE_TYPES, NODE_TYPES } from "./types.js";

export type {
  CreateEdgeInput,
  CreateNodeInput,
  EdgeType,
  Evidence,
  GraphTraversalHop,
  KnowledgeEdge,
  KnowledgeNode,
  LifecycleHistoryEntry,
  NodeType,
  UpdateNodeInput,
} from "./types.js";
export { EDGE_TYPES, NODE_TYPES } from "./types.js";
export { SCHEMA_SQL } from "./schema.js";
export { validateEvidence } from "./evidence.js";

export interface GraphStoreOptions {
  /** Project root; default DB path is `<root>/.dev-mem/graph.sqlite`. */
  projectRoot?: string;
  /** Explicit DB path. Use `:memory:` in tests. */
  dbPath?: string;
  /** Skip creating `.dev-mem/` and gitignore (used with `:memory:`). */
  ephemeral?: boolean;
}

interface NodeRow {
  id: string;
  type: string;
  title: string;
  content: string;
  lifecycle_state: string;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isNodeType(value: string): value is NodeType {
  return (NODE_TYPES as readonly string[]).includes(value);
}

function isEdgeType(value: string): value is EdgeType {
  return (EDGE_TYPES as readonly string[]).includes(value);
}

const FTS_STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "but", "not", "all", "can", "its",
  "this", "that", "with", "from", "into", "have", "been", "will", "when",
  "then", "than", "some", "only", "must", "also", "more", "such", "very",
  "use", "used", "uses", "using", "via", "per", "any", "out", "get", "set",
  "new", "add", "run", "or", "near",
]);

function expandCamelTokens(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function buildFtsMatchExpression(query: string): string | null {
  const rawTokens = expandCamelTokens(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !FTS_STOPWORDS.has(t));

  const unique = [...new Set(rawTokens)].slice(0, 16);
  if (unique.length === 0) return null;
  return unique.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Swappable graph persistence. Callers should depend on this class's methods
 * (createNode, createEdge, queryByType, transitionLifecycleState, walk)
 * rather than SQL so a different store can replace SQLite later.
 */
export class GraphStore {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(options: GraphStoreOptions = {}) {
    const ephemeral =
      options.ephemeral === true || options.dbPath === ":memory:";

    if (options.dbPath) {
      this.dbPath = options.dbPath;
    } else if (options.projectRoot) {
      if (!ephemeral) {
        ensureLocalDataDir(options.projectRoot);
      }
      this.dbPath = getGraphDbPath(options.projectRoot);
    } else {
      throw new Error("GraphStore requires projectRoot or dbPath");
    }

    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    // Concurrent hook processes may read and write the shared project store.
    // WAL permits readers alongside a writer; busy_timeout lets SQLite wait for
    // a short competing transaction instead of immediately failing with BUSY.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA_SQL);
    this.ensureFtsSynced();
  }

  private syncFtsNode(node: KnowledgeNode): void {
    const filesText = expandCamelTokens(node.evidence.files.join(" "));
    const symbolsText = (node.evidence.symbols ?? [])
      .map((s) => `${s} ${expandCamelTokens(s)}`)
      .join(" ");

    this.db.prepare(`DELETE FROM nodes_fts WHERE node_id = ?`).run(node.id);
    this.db
      .prepare(
        `INSERT INTO nodes_fts (node_id, title, content, files, symbols)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        `${node.title} ${expandCamelTokens(node.title)}`,
        node.content,
        filesText,
        symbolsText,
      );
  }

  private ensureFtsSynced(): void {
    const missing = this.db
      .prepare(
        `SELECT n.* FROM nodes n
         LEFT JOIN nodes_fts f ON f.node_id = n.id
         WHERE f.node_id IS NULL`,
      )
      .all() as unknown as NodeRow[];

    if (missing.length === 0) return;
    const backfill = this.db.transaction(() => {
      for (const row of missing) {
        this.syncFtsNode(this.rowToNode(row));
      }
    });
    backfill();
  }

  close(): void {
    this.db.close();
  }

  createNode(input: CreateNodeInput): KnowledgeNode {
    if (!isNodeType(input.type)) {
      throw new Error(`Unknown node type: ${String(input.type)}`);
    }
    if (typeof input.title !== "string" || input.title.trim() === "") {
      throw new Error("title is required");
    }

    const evidence = normalizeEvidence(input.evidence);
    const defaultTs = nowIso();
    const createdAt = input.created_at ?? defaultTs;
    const updatedAt = input.updated_at ?? createdAt;
    const state: LifecycleState = input.lifecycle_state ?? "observed";
    if (!isLifecycleState(state)) {
      throw new Error(`Unknown lifecycle state: ${String(state)}`);
    }

    const node: KnowledgeNode = {
      id: input.id ?? randomUUID(),
      type: input.type,
      title: input.title.trim(),
      content: input.content ?? "",
      lifecycle_state: state,
      evidence,
      created_at: createdAt,
      updated_at: updatedAt,
    };

    const insert = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO nodes (
           id, type, title, content, lifecycle_state,
           evidence_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        node.id,
        node.type,
        node.title,
        node.content,
        node.lifecycle_state,
        JSON.stringify(node.evidence),
        node.created_at,
        node.updated_at,
      );

      this.db.prepare(
        `INSERT INTO lifecycle_history (node_id, from_state, to_state, timestamp)
         VALUES (?, NULL, ?, ?)`,
      ).run(node.id, node.lifecycle_state, node.created_at);

      this.syncFtsNode(node);
    });
    insert();

    return node;
  }

  getNode(id: string): KnowledgeNode | undefined {
    const row = this.db
      .prepare(`SELECT * FROM nodes WHERE id = ?`)
      .get(id) as unknown as NodeRow | undefined;
    return row ? this.rowToNode(row) : undefined;
  }

  /**
   * Resolve a node by full ID or unique ID prefix (minimum 4 chars recommended).
   * Throws an error if a prefix matches multiple nodes.
   */
  resolveNode(idOrPrefix: string): KnowledgeNode | undefined {
    const trimmed = idOrPrefix.trim();
    if (!trimmed) return undefined;

    const exact = this.getNode(trimmed);
    if (exact) return exact;

    const escaped = trimmed.replace(/[\\%_]/g, "\\$&");
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at ASC`)
      .all(`${escaped}%`) as unknown as NodeRow[];

    if (rows.length === 0) return undefined;
    if (rows.length > 1) {
      const sample = rows
        .slice(0, 4)
        .map((r) => r.id.slice(0, 10))
        .join(", ");
      throw new Error(
        `Ambiguous node ID prefix "${trimmed}" matches ${rows.length} nodes (${sample}${rows.length > 4 ? ", ..." : ""}). Provide a longer prefix.`,
      );
    }
    return this.rowToNode(rows[0]);
  }

  updateNode(nodeId: string, patch: UpdateNodeInput): KnowledgeNode {
    const existing = this.getNode(nodeId);
    if (!existing) {
      throw new Error(`Unknown node id: ${nodeId}`);
    }

    let nextTitle = existing.title;
    if (patch.title !== undefined) {
      if (typeof patch.title !== "string" || patch.title.trim() === "") {
        throw new Error("title cannot be empty");
      }
      nextTitle = patch.title.trim();
    }

    const nextContent = patch.content !== undefined ? patch.content : existing.content;
    const nextEvidence = patch.evidence !== undefined ? normalizeEvidence(patch.evidence) : existing.evidence;
    const nextUpdatedAt = patch.updated_at ?? nowIso();

    this.db
      .prepare(
        `UPDATE nodes SET title = ?, content = ?, evidence_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(nextTitle, nextContent, JSON.stringify(nextEvidence), nextUpdatedAt, nodeId);

    const updated = this.getNode(nodeId);
    if (!updated) {
      throw new Error(`Node disappeared after update: ${nodeId}`);
    }
    this.syncFtsNode(updated);
    return updated;
  }

  /**
   * Searches the SQLite FTS5 index using BM25 weighting across title (3.0),
   * symbols (2.5), files (2.0), and content (1.5). Returns descending [0, 1]
   * normalized relevance scores keyed by node ID.
   */
  searchFts(query: string, limit = 50): Array<{ id: string; score: number }> {
    const matchExpr = buildFtsMatchExpression(query);
    if (!matchExpr) return [];

    try {
      const rows = this.db
        .prepare(
          `SELECT node_id AS id, bm25(nodes_fts, 0.0, 3.0, 1.5, 2.0, 2.5) AS raw_rank
           FROM nodes_fts
           WHERE nodes_fts MATCH ?
           ORDER BY raw_rank ASC
           LIMIT ?`,
        )
        .all(matchExpr, limit) as Array<{ id: string; raw_rank: number }>;

      if (rows.length === 0) return [];

      // SQLite FTS5 bm25() returns more negative numbers for stronger matches.
      // Shift relative to worst rank on small corpora where IDF can be >= 0 so
      // ordering stays strictly monotonic while mapping cleanly to (0, 1].
      return rows.map((row, idx) => {
        const mag = row.raw_rank < 0 ? -row.raw_rank : 0.05 / (1 + row.raw_rank);
        const bm25Norm = mag / (mag + 1.5);
        const rankDecay = Math.max(0.2, 1 - idx * 0.05);
        const score = Math.min(1, Math.max(0.12, bm25Norm * 0.75 + rankDecay * 0.25));
        return { id: row.id, score };
      });
    } catch {
      return [];
    }
  }

  createEdge(input: CreateEdgeInput): KnowledgeEdge {
    if (!isEdgeType(input.type)) {
      throw new Error(`Unknown edge type: ${String(input.type)}`);
    }

    const from = this.getNode(input.from_id);
    const to = this.getNode(input.to_id);
    if (!from) {
      throw new Error(`Unknown from_id: ${input.from_id}`);
    }
    if (!to) {
      throw new Error(`Unknown to_id: ${input.to_id}`);
    }

    const edge: KnowledgeEdge = {
      id: input.id ?? randomUUID(),
      from_id: input.from_id,
      to_id: input.to_id,
      type: input.type,
      created_at: nowIso(),
    };

    this.db
      .prepare(
        `INSERT INTO edges (id, from_id, to_id, type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(edge.id, edge.from_id, edge.to_id, edge.type, edge.created_at);

    if (input.type === "supersedes" && to.lifecycle_state !== "superseded") {
      this.transitionLifecycleState(to.id, "superseded");
    }

    return edge;
  }

  queryByType(type: NodeType): KnowledgeNode[] {
    if (!isNodeType(type)) {
      throw new Error(`Unknown node type: ${String(type)}`);
    }
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE type = ? ORDER BY created_at ASC`)
      .all(type) as unknown as NodeRow[];
    return rows.map((row) => this.rowToNode(row));
  }

  queryAllNodes(): KnowledgeNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM nodes ORDER BY created_at ASC`)
      .all() as unknown as NodeRow[];
    return rows.map((row) => this.rowToNode(row));
  }

  transitionLifecycleState(
    nodeId: string,
    toState: LifecycleState,
    updatedAt?: string,
  ): KnowledgeNode {
    if (!isLifecycleState(toState)) {
      throw new Error(`Unknown lifecycle state: ${String(toState)}`);
    }

    const node = this.getNode(nodeId);
    if (!node) {
      throw new Error(`Unknown node id: ${nodeId}`);
    }

    assertTransition(node.lifecycle_state, toState);
    if (node.lifecycle_state === toState) {
      return node;
    }

    const timestamp = updatedAt ?? nowIso();
    this.db
      .prepare(
        `UPDATE nodes SET lifecycle_state = ?, updated_at = ? WHERE id = ?`,
      )
      .run(toState, timestamp, nodeId);

    this.db
      .prepare(
        `INSERT INTO lifecycle_history (node_id, from_state, to_state, timestamp)
         VALUES (?, ?, ?, ?)`,
      )
      .run(nodeId, node.lifecycle_state, toState, timestamp);

    const updated = this.getNode(nodeId);
    if (!updated) {
      throw new Error(`Node disappeared after transition: ${nodeId}`);
    }
    return updated;
  }

  /**
   * Recursive CTE walk along one edge type (spec §14).
   */
  walk(
    startId: string,
    edgeType: EdgeType,
    direction: "outgoing" | "incoming" = "outgoing",
  ): GraphTraversalHop[] {
    if (!isEdgeType(edgeType)) {
      throw new Error(`Unknown edge type: ${String(edgeType)}`);
    }
    const sql = direction === "outgoing" ? WALK_OUTGOING_SQL : WALK_INCOMING_SQL;
    const rows = this.db.prepare(sql).all(
      startId,
      edgeType,
      edgeType,
    ) as unknown as Array<{
      id: string;
      depth: number;
    }>;
    return rows.map((row) => ({ id: row.id, depth: Number(row.depth) }));
  }

  listEdges(nodeId?: string): KnowledgeEdge[] {
    const rows = (
      nodeId
        ? (this.db
            .prepare(
              `SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY created_at ASC`,
            )
            .all(nodeId, nodeId) as unknown as EdgeRow[])
        : (this.db
            .prepare(`SELECT * FROM edges ORDER BY created_at ASC`)
            .all() as unknown as EdgeRow[])
    );
    return rows.map((row) => this.rowToEdge(row));
  }

  listLifecycleHistory(nodeId: string): LifecycleHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, node_id, from_state, to_state, timestamp
         FROM lifecycle_history WHERE node_id = ? ORDER BY id ASC`,
      )
      .all(nodeId) as unknown as Array<{
      id: number;
      node_id: string;
      from_state: string | null;
      to_state: string;
      timestamp: string;
    }>;

    return rows.map((row) => ({
      id: Number(row.id),
      node_id: row.node_id,
      from_state: row.from_state as LifecycleState | null,
      to_state: row.to_state as LifecycleState,
      timestamp: row.timestamp,
    }));
  }

  private rowToNode(row: NodeRow): KnowledgeNode {
    if (!isNodeType(row.type)) {
      throw new Error(`Corrupt node type in store: ${row.type}`);
    }
    if (!isLifecycleState(row.lifecycle_state)) {
      throw new Error(`Corrupt lifecycle state in store: ${row.lifecycle_state}`);
    }
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      lifecycle_state: row.lifecycle_state,
      evidence: JSON.parse(row.evidence_json) as KnowledgeNode["evidence"],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private rowToEdge(row: EdgeRow): KnowledgeEdge {
    if (!isEdgeType(row.type)) {
      throw new Error(`Corrupt edge type in store: ${row.type}`);
    }
    return {
      id: row.id,
      from_id: row.from_id,
      to_id: row.to_id,
      type: row.type,
      created_at: row.created_at,
    };
  }
}
