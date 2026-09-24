/**
 * SQLite schema for the knowledge graph (spec §5, §14).
 *
 * Driver is better-sqlite3 (swapped from node:sqlite in V2).
 * The SQLite+CTE choice itself is unvalidated per spec §14a — keep the
 * GraphStore public API stable if the backend is swapped later.
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN (
      'Decision',
      'FailedApproach',
      'Constraint',
      'Discovery',
      'Convention',
      'OpenIssue'
    )
  ),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN (
      'observed',
      'verified',
      'active',
      'superseded',
      'stale'
    )
  ),
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes (type);
CREATE INDEX IF NOT EXISTS idx_nodes_lifecycle ON nodes (lifecycle_state);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES nodes (id),
  to_id TEXT NOT NULL REFERENCES nodes (id),
  type TEXT NOT NULL CHECK (
    type IN (
      'supersedes',
      'contradicts',
      'depends-on',
      'discovered-from',
      'resolves'
    )
  ),
  created_at TEXT NOT NULL,
  UNIQUE (from_id, to_id, type)
);

CREATE INDEX IF NOT EXISTS idx_edges_from_type ON edges (from_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_to_type ON edges (to_id, type);

CREATE TABLE IF NOT EXISTS lifecycle_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes (id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_history_node
  ON lifecycle_history (node_id);
`;

/**
 * Walk the graph along a single edge type using a recursive CTE (spec §14).
 * direction = outgoing: follow from_id → to_id
 * direction = incoming: follow to_id → from_id
 */
export const WALK_OUTGOING_SQL = `
WITH RECURSIVE walk (id, depth) AS (
  SELECT e.to_id, 1
  FROM edges e
  WHERE e.from_id = ? AND e.type = ?
  UNION
  SELECT e.to_id, w.depth + 1
  FROM edges e
  JOIN walk w ON e.from_id = w.id
  WHERE e.type = ? AND w.depth < 64
)
SELECT id, depth FROM walk
`;

export const WALK_INCOMING_SQL = `
WITH RECURSIVE walk (id, depth) AS (
  SELECT e.from_id, 1
  FROM edges e
  WHERE e.to_id = ? AND e.type = ?
  UNION
  SELECT e.from_id, w.depth + 1
  FROM edges e
  JOIN walk w ON e.to_id = w.id
  WHERE e.type = ? AND w.depth < 64
)
SELECT id, depth FROM walk
`;
