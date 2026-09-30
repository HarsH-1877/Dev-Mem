# Dev-Mem — Technical Report

**Version:** 0.2.1 (V2 Feature-Complete)  
**Date:** September 2026  
**Author:** Harsh Asalkar  
**Repository:** [github.com/HarsH-1877/Dev-Mem](https://github.com/HarsH-1877/Dev-Mem)  
**Package:** [npmjs.com/package/dev-memo](https://www.npmjs.com/package/dev-memo)  
**License:** MIT  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Product Design & Constraints](#3-product-design--constraints)
4. [System Architecture](#4-system-architecture)
5. [Technology Stack](#5-technology-stack)
6. [Core Modules — Detailed Breakdown](#6-core-modules--detailed-breakdown)
   - 6.1 Knowledge Graph Store
   - 6.2 Deterministic Capture Pipeline
   - 6.3 LLM Extraction Engine
   - 6.4 Budget-Constrained Retrieval
   - 6.5 Regression Intelligence
   - 6.6 Consistency Checks
   - 6.7 Knowledge Lifecycle State Machine
   - 6.8 LLM Provider Abstraction
7. [Agent Adapters](#7-agent-adapters)
8. [CLI Interface](#8-cli-interface)
9. [Evaluation Methodology & Results](#9-evaluation-methodology--results)
10. [Use Case Guide](#10-use-case-guide)
11. [Current Gaps & Limitations](#11-current-gaps--limitations)
12. [Roadmap & Vision](#12-roadmap--vision)
13. [Glossary](#13-glossary)

---

## 1. Executive Summary

Dev-Mem is a local-first, cross-agent state persistence layer for AI coding tools. It addresses a structural deficiency in current AI coding assistants: **session amnesia** — the complete loss of accumulated project context when a session terminates or a developer switches between tools.

Dev-Mem maintains a typed, evidence-linked knowledge graph (`graph.sqlite`) within the project root. It records architectural decisions, failed approaches, constraints, discoveries, and conventions that an AI agent accumulates during a coding session. At the start of each subsequent session — regardless of which agent is used — Dev-Mem injects the most relevant subset of this knowledge into the agent's context window, preventing redundant investigation and actively blocking known-failed approaches in real time.

### Key Metrics (V2 Evaluation)

| Metric | Without Dev-Mem | With Dev-Mem | Impact |
|--------|-----------------|--------------|--------|
| Redundant discoveries | 13 events | 0 events | **100% eliminated** |
| Regression repeat rate | 8.3% | 0.0% | **Fully blocked** |
| Net token delta | 4,661 tokens | 4,099 tokens | **+562 tokens saved** |
| Task success rate | 100% | 100% | Parity maintained |
| Cross-agent knowledge transfer | N/A | 17 nodes transferred | Claude Code → Codex |

---

## 2. Problem Statement

AI coding agents — including Claude Code, Cursor, Codex, and OpenCode — lose all higher-level development knowledge between sessions and between tools. Git and the filesystem preserve *what the code currently is*. They do **not** preserve:

- **Why** an architectural decision was made
- **What approaches** were already tried and failed, and why
- Important **assumptions and constraints**
- **Discoveries** about the codebase (e.g., "session validation lives in `src/auth/session.ts`")
- **Unresolved problems** from prior sessions
- **Conventions** established during development
- What a previous agent already investigated
- What should or should not be attempted again

The result: every new session (and every switch between agents) re-discovers the same things, re-attempts previously failed approaches, and burns tokens and time re-deriving context that a prior agent already had.

### Concrete Example

```
Session 1 (Claude Code):
  Developer discovers SQLite won't work for their use case due to
  concurrent write limitations. Agent switches to PostgreSQL.
  Session ends.

Session 2 (Cursor, same project):
  Developer asks agent to implement a database module.
  Agent has zero context → re-proposes SQLite → developer corrects it again.
  Wasted: ~200 tokens + developer time.

Session 2 (WITH Dev-Mem):
  Cursor receives injected context on SessionStart:
    [FAILED APPROACH] "SQLite rejected due to concurrent write limitations"
    [DECISION] "Use PostgreSQL for production database"
  Agent immediately implements PostgreSQL. Zero redundancy.
```

---

## 3. Product Design & Constraints

### 3.1 Distribution Model

Dev-Mem is an **npm CLI package** with an internal core library and per-agent adapters — local-first, no server, no hosted service.

```
┌─────────────────────────────────────────────────────┐
│                    dev-memo (npm)                    │
├─────────────┬──────────────────┬────────────────────┤
│  CLI Layer  │   Core Library   │  Agent Adapters    │
│  cli/       │   core/          │  adapters/         │
│             │                  │                    │
│  install    │  graph store     │  claude-code/      │
│  status     │  capture         │  codex/            │
│  query      │  extraction      │  cursor/           │
│  inspect    │  retrieval       │  opencode/         │
│  uninstall  │  regression      │                    │
│  extract    │  consistency     │                    │
│  wrap       │  lifecycle       │                    │
│             │  llm             │                    │
└─────────────┴──────────────────┴────────────────────┘
```

### 3.2 Non-Negotiable Design Constraints

These constraints override any individual feature idea. If a feature conflicts with one of these, the feature is wrong, not the constraint.

| # | Constraint | Rationale |
|---|-----------|-----------|
| 1 | **Net token-neutral or token-positive** | Capture is near-zero-cost (deterministic, not LLM-per-event). Retrieval is budget-constrained. Tokens spent on memory operations must never exceed tokens saved by avoided rediscovery. |
| 2 | **No hallucination amplification** | Injected context is structured, evidence-linked, and confidence-labeled. Low-confidence items are omitted rather than injected. |
| 3 | **Deterministic capture first, LLM second** | Everything capturable from git/filesystem/tool-call events is captured without LLM calls. LLM calls are reserved exclusively for batched knowledge extraction. |
| 4 | **Local-first, no server** | All data lives in the user's own project (`.dev-mem/`). No hosted backend, no telemetry, no external service dependency. |
| 5 | **Evidence is mandatory** | Every knowledge item must cite at least a commit/diff/file. No uncorroborated claims enter the graph. |
| 6 | **Provider-neutral** | Claude Code, Codex, Cursor, and OpenCode are all first-class citizens, not "Claude Code plus adapters bolted on later." |

### 3.3 Local Data Location

Dev-Mem creates a `.dev-mem/` directory at the project root (sibling to `.claude/`, `.cursor/`, etc.):

```
.dev-mem/
├── graph.sqlite      # Knowledge graph (SQLite, WAL mode)
├── events.jsonl      # Deterministic capture log (append-only)
├── config.yml        # User-configurable settings (optional)
└── .gitignore        # Auto-generated; keeps .dev-mem/ local by default
```

---

## 4. System Architecture

### 4.1 High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AGENT SESSION                               │
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌──────────┐    ┌──────────┐   │
│  │ Session  │───▶│  Tool Calls  │───▶│  Agent   │───▶│ Session │  │
│  │  Start   │    │  (Write/     │    │  Stop    │    │   End    │   │
│  │          │    │   Edit/Cmd)  │    │          │    │          │   │
│  └────┬─────┘    └──────┬───────┘    └────┬─────┘    └────┬─────┘   │
│       │                 │                 │               │         │
└───────┼─────────────────┼─────────────────┼───────────────┼─────────┘
        │                 │                 │               │
        ▼                 ▼                 ▼               ▼
┌───────────────────────────────────────────────────────────────────┐
│                    DEV-MEM HOOK LAYER                             │
│                                                                   │
│  SessionStart:          PostToolUse:       Stop:       SessionEnd:│
│  ┌─────────────────┐   ┌──────────────┐  ┌────────┐  ┌────────┐   │
│  │ 1. Retrieve     │   │ 1. Log event │  │ Git    │  │ Trigger│   │
│  │    context      │   │ 2. Regression│  │ snap   │  │ async  │   │
│  │ 2. Regression   │   │    check on  │  │        │  │ LLM    │   │
│  │    pre-check    │   │    file edits│  │        │  │extract │   │ 
│  │ 3. Inject into  │   │              │  │        │  │        │   │
│  │    agent prompt │   │              │  │        │  │        │   │
│  └─────────────────┘   └──────────────┘  └────────┘  └────────┘   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
        │                 │                 │               │
        ▼                 ▼                 ▼               ▼
┌────────────────────────────────────────────────────────────────────┐
│                       CORE ENGINE                                  │
│                                                                    │
│  ┌────────────┐  ┌──────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ Retrieval  │  │ Deterministic│  │Regression  │  │ Extraction │  │
│  │ (ranking + │  │  Capture     │  │Intelligence│  │ (batched   │  │
│  │  knapsack) │  │ (zero LLM)   │  │ (active    │  │  LLM call) │  │
│  │            │  │              │  │  blocking) │  │            │  │
│  └──────┬─────┘  └──────┬───────┘  └─────┬──────┘  └──────┬─────┘  │
│         │               │               │              │           │
│         ▼               ▼               ▼              ▼           │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │              .dev-mem/graph.sqlite                       │      │
│  │              (Knowledge Graph)                           │      │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐   │      │
│  │  │    Nodes    │  │    Edges     │  │   Lifecycle    │   │      │
│  │  │  (6 types)  │  │  (5 types)   │  │    History     │   │      │
│  │  └─────────────┘  └──────────────┘  └────────────────┘   │      │
│  └──────────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Core Processing Loop

```
Agent activity
  → Deterministic capture (git diff, file touches, commands, test results — zero LLM cost)
  → Batched LLM extraction at checkpoints (session end / N tool-calls)
  → Typed knowledge nodes with mandatory evidence
  → Lifecycle state assignment (observed → verified → active → superseded → stale)
  → Budget-constrained ranked retrieval
  → Structured, labeled, confidence-tagged context assembly
  → Injected into next agent/session
```

### 4.3 Cross-Agent Knowledge Sharing Model

All agents share the same `.dev-mem/graph.sqlite` in the project root. When Agent A (e.g., Claude Code) records knowledge, Agent B (e.g., Cursor) reads it on next session start.

```
  Claude Code         Codex           Cursor          OpenCode
       │                │                │                │
       ▼                ▼                ▼                ▼
  .claude/hooks    .codex/hooks    .cursor/hooks    .opencode/plugins
       │                │                │                │
       └────────────────┴────────────────┴────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │  .dev-mem/graph.sqlite  │
                    │  (shared knowledge      │
                    │   graph)                │
                    └─────────────────────────┘
```

---

## 5. Technology Stack

### 5.1 Stack Overview

| Component | Technology | Purpose | Confidence Level |
|-----------|-----------|---------|-----------------|
| Language & Runtime | TypeScript on Node.js 22+ | Hook scripts are JSON over stdin/stdout. Node.js is guaranteed available on all platforms where Claude Code runs. Python is not. | **High** — technically justified |
| Package Distribution | npm (`dev-memo`) | CLI binary `dev-memo`. Matches how comparable tools distribute (e.g., `npx claude-mem install`, `bd init`). | **High** — proven pattern |
| Graph Store | SQLite via `better-sqlite3` | Local file at `.dev-mem/graph.sqlite`. Zero server dependency. Graph modeled via relational tables + recursive CTEs for edge traversal. | **Medium-low** — unvalidated vs. embedded graph DBs |
| Concurrency | WAL mode + `busy_timeout=5000` | Permits readers alongside a writer. Hook processes wait briefly for competing transactions instead of failing with SQLITE_BUSY. | **High** — standard SQLite concurrency pattern |
| Capture Hooks | Native agent hook systems | SessionStart/PostToolUse/Stop/SessionEnd via JSON over stdin/stdout. Language-agnostic protocol. | **High** — documented APIs |
| Extraction | Single batched LLM call per checkpoint | Structured JSON output matching the knowledge node schema. The **only** place an LLM call occurs in the entire pipeline. | **High** — validated in eval |
| Retrieval Scoring | Plain TypeScript (Jaccard + exponential decay + knapsack) | No external dependencies. Adaptive budget default prevents over-injection on small graphs. | **Medium-high** — validated in V1/V2 eval |
| Testing | Vitest | Unit and integration tests. The specific Vitest-vs-Jest choice is arbitrary. | **Low** — arbitrary |
| License | MIT | Matches ecosystem norms for developer tooling. | **High** — standard |

### 5.2 Dependencies

Dev-Mem maintains a minimal dependency footprint:

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `better-sqlite3` | ^13.0.3 | Synchronous, high-performance SQLite driver for Node.js. Used for the knowledge graph store. Chosen over `node:sqlite` for broader compatibility. |

**Dev Dependencies:**

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `typescript` | ^7.0.2 | TypeScript compiler |
| `vitest` | ^5.0.1 | Test runner |
| `@vitest/coverage-v8` | ^5.0.1 | Code coverage via V8 |
| `@types/better-sqlite3` | ^9.6.0 | Type definitions for the SQLite driver |
| `@types/node` | ^22.20.3 | Node.js type definitions |

> **Note:** LLM provider calls (Anthropic, OpenAI, Gemini) use **native `fetch()`** — no SDK dependencies. Each provider implementation is a thin HTTP wrapper.

### 5.3 Project Structure

```
dev-mem/
├── cli/
│   └── index.ts              # CLI commands: install, status, query, inspect, etc.
├── core/
│   ├── capture/
│   │   ├── index.ts           # DeterministicCapture class (zero LLM cost)
│   │   ├── events.ts          # CaptureEvent type definitions
│   │   ├── git.ts             # Git snapshot collection (branch, diff, status)
│   │   └── log.ts             # Append-only EventLog (events.jsonl)
│   ├── extraction/
│   │   └── index.ts           # Batched LLM extraction pipeline
│   ├── graph/
│   │   ├── index.ts           # GraphStore class (CRUD, walk, transitions)
│   │   ├── schema.ts          # SQLite DDL + recursive CTE queries
│   │   ├── types.ts           # KnowledgeNode, Evidence, Edge types
│   │   └── evidence.ts        # Evidence normalization & validation
│   ├── retrieval/
│   │   └── index.ts           # Scoring (relevance, freshness, confidence,
│   │                          #   proximity) + adaptive budget + knapsack
│   ├── regression/
│   │   └── index.ts           # Regression Intelligence (FailedApproach matching)
│   ├── consistency/
│   │   └── index.ts           # Contradiction detection + staleness checks
│   ├── lifecycle/
│   │   └── index.ts           # State machine (observed → ... → stale)
│   ├── llm/
│   │   ├── index.ts           # Provider resolution (env vars, config file)
│   │   ├── types.ts           # LlmProvider interface
│   │   ├── anthropic.ts       # Anthropic Claude provider (native fetch)
│   │   ├── openai.ts          # OpenAI/OpenAI-compatible provider (native fetch)
│   │   └── gemini.ts          # Google Gemini provider (native fetch)
│   ├── local-data.ts          # .dev-mem/ directory management
│   └── extraction-lock.ts     # Per-session extraction lock (prevents duplicates)
├── adapters/
│   ├── claude-code/
│   │   ├── hook.ts            # Claude Code hook handler
│   │   └── types.ts           # Claude Code payload types
│   ├── codex/
│   │   ├── hook.ts            # Codex hook handler
│   │   └── types.ts           # Codex payload types
│   ├── cursor/
│   │   ├── hook.ts            # Cursor hook handler
│   │   └── types.ts           # Cursor payload types
│   └── opencode/
│       ├── hook.ts            # OpenCode hook handler
│       └── types.ts           # OpenCode payload types
├── eval/
│   ├── harness/
│   │   ├── index.ts           # Single-agent eval harness
│   │   └── cross-agent.ts     # Cross-agent eval harness
│   ├── sample-repo/           # Fixed test repository with 12 dependent tasks
│   └── results/               # Published evaluation results (V1 + V2)
├── docs/                      # Documentation
├── tests/                     # Integration tests
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 6. Core Modules — Detailed Breakdown

### 6.1 Knowledge Graph Store

**Location:** `core/graph/`

The graph store is the central persistence layer. It models development knowledge as a typed, directed graph with lifecycle-aware nodes and relationship edges.

#### 6.1.1 Database Schema

Three SQLite tables form the knowledge graph:

**`nodes` table:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | UUIDv4 |
| `type` | TEXT | One of: `Decision`, `FailedApproach`, `Constraint`, `Discovery`, `Convention`, `OpenIssue` |
| `title` | TEXT | Concise one-line summary |
| `content` | TEXT | Detailed explanation and context |
| `lifecycle_state` | TEXT | One of: `observed`, `verified`, `active`, `superseded`, `stale` |
| `evidence_json` | TEXT | JSON blob containing the full Evidence schema |
| `created_at` | TEXT | ISO 8601 timestamp |
| `updated_at` | TEXT | ISO 8601 timestamp |

**`edges` table:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | UUIDv4 |
| `from_id` | TEXT (FK → nodes) | Source node |
| `to_id` | TEXT (FK → nodes) | Target node |
| `type` | TEXT | One of: `supersedes`, `contradicts`, `depends-on`, `discovered-from`, `resolves` |
| `created_at` | TEXT | ISO 8601 timestamp |
| UNIQUE | — | `(from_id, to_id, type)` — prevents duplicate edges |

**`lifecycle_history` table:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER (PK, AUTO) | Sequential ID |
| `node_id` | TEXT (FK → nodes) | The node that transitioned |
| `from_state` | TEXT (nullable) | Previous state (null on creation) |
| `to_state` | TEXT | New state |
| `timestamp` | TEXT | ISO 8601 timestamp |

#### 6.1.2 Node Types

| Type | Description | Example |
|------|-------------|---------|
| `Decision` | An architectural or implementation choice, with rationale | "Use Firebase Admin for server-side auth" |
| `FailedApproach` | Something tried and rejected, with the reason | "Client-side token verification caused inconsistent server session state" |
| `Constraint` | A rule the codebase must obey | "Provider-specific auth logic must stay behind `AuthProvider`" |
| `Discovery` | A fact learned about the existing codebase | "Session validation is centralized in `src/auth/session.ts`" |
| `Convention` | An established pattern/style | "All API routes use zod schemas for input validation" |
| `OpenIssue` | Known unresolved problem | "OAuth E2E tests still fail in production-like environments" |

#### 6.1.3 Edge Types

| Edge | Meaning |
|------|---------|
| `supersedes` | Node A replaces/overrides Node B. Automatically transitions B to `superseded`. |
| `contradicts` | Node A and Node B cannot both be true; needs resolution. |
| `depends-on` | Node A only makes sense given Node B. |
| `discovered-from` | Node A was found while working on task/session B. |
| `resolves` | Node A (e.g., a Decision) closes Node B (e.g., an OpenIssue). |

#### 6.1.4 Evidence Schema

Every node requires mandatory provenance:

```typescript
interface Evidence {
  commit: string;        // Required — git SHA
  files: string[];       // Required — at least one file path
  diff_ref?: string;     // Optional — commit range reference
  test_ref?: string;     // Optional — test name/path
  symbols?: string[];    // Optional — reserved for V3 symbol grounding
  session_id: string;    // Required — which session produced this
  agent: string;         // Required — which agent produced this
  timestamp: string;     // Required — ISO 8601
  confidence: number;    // Required — 0.0 to 1.0, extraction confidence
}
```

#### 6.1.5 Graph Traversal

The graph supports recursive traversal along edge types using SQLite's recursive CTEs:

```sql
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
```

This enables queries like "find all nodes that this Decision transitively supersedes" or "walk the full dependency chain of this Constraint."

#### 6.1.6 Concurrency

```typescript
this.db.pragma("journal_mode = WAL");
this.db.pragma("busy_timeout = 5000");
```

WAL (Write-Ahead Logging) mode permits multiple concurrent readers alongside a single writer. The 5-second busy timeout ensures that when two hook processes (e.g., PostToolUse firing on rapid edits) compete for a write lock, the second process waits briefly instead of immediately failing with `SQLITE_BUSY`.

---

### 6.2 Deterministic Capture Pipeline

**Location:** `core/capture/`

The capture layer records raw development events with **zero LLM cost**. It extracts everything that can be captured deterministically from git and the filesystem.

#### 6.2.1 Captured Event Types

| Event Type | Fields | Source |
|-----------|--------|--------|
| `session_start` | `project_root`, `session_id`, `agent` | Agent SessionStart hook |
| `session_end` | `session_id` | Agent SessionEnd hook |
| `git_snapshot` | `branch`, `head_commit`, `worktree`, `worktrees[]`, `status[]`, `diff`, `staged_diff`, `recent_commits[]` | Git CLI (`git status`, `git diff`, `git log`) |
| `file_touch` | `path`, `action` (created/modified/deleted/touched) | Working tree changes |
| `tool_call` | `command`, `args[]`, `exit_code`, `stdout`, `stderr`, `test_pass` | Agent tool execution |

#### 6.2.2 Event Storage

Events are stored in an append-only JSONL file at `.dev-mem/events.jsonl`. Each line is a single JSON object. This format supports:

- Atomic appends (crash-safe — partial writes corrupt at most one line)
- Streaming reads (extraction reads line-by-line)
- Minimal I/O overhead (no parsing overhead for the full file on each append)

#### 6.2.3 Git Snapshot Collection

The `collectGitSnapshot()` function runs the following git commands:

| Command | Data Captured |
|---------|--------------|
| `git rev-parse --show-toplevel` | Worktree root path |
| `git rev-parse --abbrev-ref HEAD` | Current branch name |
| `git rev-parse HEAD` | HEAD commit SHA |
| `git status --porcelain -u` | Working tree modifications |
| `git diff` | Unstaged changes |
| `git diff --cached` | Staged changes |
| `git worktree list --porcelain` | All active worktrees |
| `git log -n20 --format=...` | Recent commit metadata |

All git operations are synchronous (`execFileSync`) and gracefully degrade if git is unavailable or the directory is not a repository.

---

### 6.3 LLM Extraction Engine

**Location:** `core/extraction/index.ts`

Extraction is the **only** place an LLM call occurs in the entire Dev-Mem pipeline. It is invoked once per session checkpoint (session end or N-accumulated-events trigger).

#### 6.3.1 Extraction Pipeline

```
  Session Events (events.jsonl)
         │
         ▼
  ┌──────────────────────────────┐
  │  1. Filter events for this   │
  │     session ID               │
  │  2. Discover context         │
  │     (agent, commit, files)   │
  │  3. Load existing active     │
  │     graph nodes for          │
  │     contradiction detection  │
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐
  │  4. Format extraction prompt │
  │     - Session events as JSON │
  │     - Existing node context  │
  │     - Schema definition      │
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐
  │  5. Single batched LLM call  │
  │     (Claude / GPT / Gemini   │
  │      / Ollama)               │
  │     Response: JSON with      │
  │     typed nodes +            │
  │     contradicts_edges        │
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐
  │  6. Parse & validate JSON    │
  │     - Strip code fences      │
  │     - Normalize node types   │
  │     - Clamp confidence [0,1] │
  │     - Ensure ≥1 file in      │
  │       evidence               │
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐
  │  7. Insert nodes into        │
  │     GraphStore               │
  │     (lifecycle: "observed")  │
  │  8. Create contradiction     │
  │     edges from LLM proposals │
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐
  │  9. Post-insertion checks    │
  │     - checkContradictions()  │
  │     - checkStaleness()       │
  └──────────────────────────────┘
```

#### 6.3.2 Prompt Structure

The extraction prompt instructs the LLM to output a single JSON object:

```json
{
  "nodes": [
    {
      "type": "Decision | FailedApproach | Constraint | ...",
      "title": "Concise summary statement",
      "content": "Detailed technical explanation",
      "files": ["relative/path/to/file1"],
      "confidence": 0.0-1.0,
      "diff_ref": "optional commit reference",
      "test_ref": "optional test path"
    }
  ],
  "contradicts_edges": [
    {
      "node_title": "Title of the new node",
      "existing_node_id": "ID of the contradicted node",
      "reason": "Why they conflict"
    }
  ]
}
```

#### 6.3.3 Safety Guarantees

- Extraction **never throws** to the caller. All errors are caught, logged, and return `{ success: false }`.
- A per-session extraction lock prevents duplicate extractions for the same session.
- The SessionEnd hook spawns extraction as a **detached background process** to avoid blocking the agent's exit (which has a ~1.5s timeout in Claude Code).

---

### 6.4 Budget-Constrained Retrieval

**Location:** `core/retrieval/index.ts`

Retrieval determines **which** knowledge nodes to inject at session start, subject to a token budget constraint.

#### 6.4.1 Scoring Formula

Each candidate node receives a composite score:

```
score(node) = 0.35 × relevance
            + 0.25 × freshness
            + 0.20 × confidence
            + 0.20 × graph_proximity
```

**Weight rationale:**

| Signal | Weight | Rationale |
|--------|--------|-----------|
| Relevance | 0.35 | Primary filter. A node about an unrelated subsystem should be suppressible regardless of freshness or confidence. |
| Freshness | 0.25 | Tie-breaker between equally relevant nodes. Should not outweigh topical match. |
| Confidence | 0.20 | Secondary quality signal (extraction confidence, not correctness). |
| Graph Proximity | 0.20 | Exact-file match is a strong but narrow signal. Booster, not dominator. |

#### 6.4.2 Scoring Component Details

**Relevance** uses Jaccard similarity between tokenized text sets:

- If `currentTask` is provided: `Jaccard(taskTokens, nodeTokens)` — where `nodeTokens = tokenise(title + content + files)`
- If only `currentFiles` is provided: Jaccard on file-path token overlap
- If neither: returns 0.5 (neutral)

Tokenization splits on non-word characters, lowercases, drops stopwords, and filters tokens shorter than 3 characters.

**Freshness** uses exponential decay:

```
freshness = e^(−ln(2)/7 × ageDays)
```

This halves the freshness score every 7 days. A node updated today scores 1.0; a node from 7 days ago scores 0.5; from 14 days ago scores 0.25.

**Confidence** is the raw `evidence.confidence` value (0.0–1.0) assigned during extraction.

**Graph Proximity** measures exact file-name overlap between the node's `evidence.files` and the current session's `currentFiles`:

```
proximity = matched_files / total_node_files
```

#### 6.4.3 Adaptive Token Budget

A flat token ceiling (e.g., 2000) makes relevance filtering a no-op on small graphs — if the entire graph costs fewer tokens than the budget, every node is always injected and scores have no effect.

The adaptive formula maintains selection pressure at any graph size:

```
budget = clamp(nodeCount × 18, 80, 2000)
```

| Graph Size | Computed Budget | Effect |
|-----------|-----------------|--------|
| 5 nodes | 90 tokens | Fits ~2–3 nodes; relevance picks the best |
| 12 nodes | 216 tokens | Fits ~6 nodes; half the graph is filtered |
| 50 nodes | 900 tokens | Moderate filtering |
| 120+ nodes | 2000 tokens (cap) | Standard large-graph budget |

#### 6.4.4 Knapsack Selection

After scoring, nodes are sorted by descending score and selected greedily under the budget constraint:

```typescript
for (const node of scoredNodes) {
  if (spent + node.cost <= budgetTokens) {
    selected.push(node);
    spent += node.cost;
  }
}
```

This is an exact solution for the typical case (small candidate sets). For large mature graphs, the greedy approach provides a good approximation.

#### 6.4.5 Context Assembly Format

Selected nodes are formatted into a structured, labeled block:

```
<dev_mem_context>
Relevant context from previous development sessions:

[DECISION] (confidence: 0.94, active today)
Use better-sqlite3 with WAL mode and busy_timeout=5000
Evidence: commit 4e2f81a, core/graph/index.ts

[FAILED APPROACH] (confidence: 0.86, observed 5 days ago)
Client-side token verification caused inconsistent server session state
Evidence: commit 9f8e7d6, src/auth/legacy_verify.ts

[CONSTRAINT] (confidence: 0.95, verified today)
Provider-specific auth logic must remain behind AuthProvider abstraction
Evidence: src/auth/provider.ts
</dev_mem_context>
```

---

### 6.5 Regression Intelligence

**Location:** `core/regression/index.ts`

Regression Intelligence is Dev-Mem's flagship active feature. It intercepts agent actions in real-time when the agent is about to repeat a known-failed approach.

#### 6.5.1 Detection Algorithm

```
  Agent about to edit/write a file
              │
              ▼
  ┌───────────────────────────────┐
  │  1. Load all FailedApproach   │
  │     nodes from graph          │
  │  2. Filter: exclude           │
  │     superseded/stale nodes    │
  │  3. Filter: confidence ≥ 0.6  │
  └───────────────┬───────────────┘
                  │
                  ▼
  ┌───────────────────────────────┐
  │  4. For each remaining node:  │
  │     - Normalize file paths    │
  │     - Compute overlap between │
  │       node.evidence.files and │
  │       currentFiles            │
  │     - overlapRatio =          │
  │       matched / total_node    │
  │     - If matchedFiles > 0:    │
  │       → add to matches        │
  └───────────────┬───────────────┘
                  │
                  ▼
  ┌───────────────────────────────┐
  │  5. Sort matches by:          │
  │     - overlapRatio (desc)     │
  │     - confidence (desc)       │
  │  6. Format warning block      │
  └───────────────────────────────┘
```

#### 6.5.2 Warning Output

When a match fires, the hook injects a structured warning block:

```
<dev_mem_regression_warning>
⚠ Regression Intelligence — known failed approaches overlap with current files:

⚠ A similar approach was already tried and failed:
"Client-side token verification caused inconsistent state"
(session: sess_182, commit: a1b2c3d, confidence: 0.86, 3 days ago, file overlap: 100%)
Detail: Exposes private key in client-side JavaScript, failing security audit.
Files: src/auth/verify.ts
</dev_mem_regression_warning>
```

#### 6.5.3 Trigger Points

Regression checks fire at two points in the hook lifecycle:

| Trigger | When | Files Checked |
|---------|------|--------------|
| **SessionStart** | Agent begins a new session | Files from `git status` (currently modified/staged) |
| **PostToolUse** | Agent completes a Write or Edit tool call | The specific file being written/edited |

---

### 6.6 Consistency Checks

**Location:** `core/consistency/index.ts`

Two narrow, scoped checks run after each extraction. These are deliberately minimal — Dev-Mem is **not** a validation/audit engine.

#### 6.6.1 Contradiction Detection

Checks whether a newly extracted node contradicts any existing active node.

**Scope:** Only checks `Decision`, `Constraint`, and `Convention` node types.

**Heuristic algorithm:**
1. Find existing nodes that share at least one file with the new node
2. Check for negation patterns in titles: "use X" vs. "don't use X", "avoid X" vs. "prefer X"
3. Verify shared key noun tokens between the two titles
4. If contradiction detected: create a `contradicts` edge in the graph

**Negation patterns matched:**

| Negation | Affirmation |
|----------|------------|
| `don't use`, `do not` | `use` |
| `avoid` | `prefer` |
| `never` | `always` |
| `prohibit`, `forbid` | `require`, `must` |

#### 6.6.2 Staleness Detection

Walks all non-stale, non-superseded nodes and marks any whose cited files no longer exist on disk as `stale`.

- **Existence check only** — no semantic re-validation
- Runs once per extraction, excluding freshly inserted nodes
- A node is marked stale only if **all** cited files are missing (partial file presence keeps the node valid)

---

### 6.7 Knowledge Lifecycle State Machine

**Location:** `core/lifecycle/index.ts`

Every knowledge node has an explicit lifecycle state, not just a timestamp:

```
observed → verified → active → superseded
                                     ↑
observed → verified → active → stale ┘
                        ↑              │
                        └──────────────┘
```

| State | Meaning |
|-------|---------|
| `observed` | Extracted from a session, not yet cross-checked |
| `verified` | Evidence (commit/diff/file) confirmed to currently exist/match |
| `active` | Verified and currently relevant (default resting state) |
| `superseded` | An explicit newer node replaces it (`supersedes` edge present) |
| `stale` | Evidence no longer resolves; surfaced for review, not silently dropped |

**Allowed transitions:**

| From | Can transition to |
|------|-------------------|
| `observed` | `verified`, `active`, `superseded`, `stale` |
| `verified` | `active`, `superseded`, `stale` |
| `active` | `superseded`, `stale` |
| `superseded` | *(terminal)* |
| `stale` | `verified`, `active`, `superseded` |

The `superseded` state is terminal — a superseded node cannot be revived. The `stale` state is recoverable — if evidence is restored, the node can transition back to `verified` or `active`.

---

### 6.8 LLM Provider Abstraction

**Location:** `core/llm/`

Dev-Mem supports multiple LLM providers for the extraction step. All implementations use **native `fetch()`** with zero SDK dependencies.

#### 6.8.1 Provider Interface

```typescript
interface LlmProvider {
  readonly name: string;
  complete(system: string, prompt: string, maxTokens: number): Promise<string>;
}
```

#### 6.8.2 Supported Providers

| Provider | Env Variable | Default Model | Notes |
|----------|-------------|---------------|-------|
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` | Direct Messages API via fetch |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o-mini` | Chat Completions API via fetch |
| **Gemini** | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-2.0-flash` | Generative Language API via fetch |
| **OpenAI-Compatible** | `DEV_MEM_LLM_BASE_URL` | `gpt-4o-mini` | Any OpenAI-compatible endpoint: Ollama, Groq, OpenRouter, LM Studio, DeepSeek. No API key required for local Ollama. |

#### 6.8.3 Resolution Priority

Provider resolution follows a strict priority order (first match wins):

1. Explicit `provider` + `apiKey` in function options
2. `DEV_MEM_LLM_PROVIDER` + `DEV_MEM_LLM_API_KEY` env vars
3. `DEV_MEM_LLM_BASE_URL` env var (OpenAI-compatible)
4. `ANTHROPIC_API_KEY` env var
5. `OPENAI_API_KEY` env var
6. `GEMINI_API_KEY` or `GOOGLE_API_KEY` env var
7. `.dev-mem/config.yml` file settings (lowest priority)

---

## 7. Agent Adapters

**Location:** `adapters/`

Adapters are thin glue modules that translate each agent's native hook/event system into calls against the core library. No core changes are required to add a new adapter.

### 7.1 Adapter Interface

Each adapter maps the standard lifecycle events:

```
onSessionStart(context) → Inject assembled context into agent
onToolCall(event)       → Forward to deterministic capture
onSessionEnd(transcript) → Trigger batched extraction
```

### 7.2 Per-Agent Hook Mapping

| Lifecycle Event | Claude Code | Codex | Cursor | OpenCode |
|----------------|------------|-------|--------|----------|
| **Session Start** | `SessionStart` | `SessionStart` | `sessionStart` | `chat.message` |
| **Pre-Tool Use** | — | `PreToolUse` | `preToolUse` | — |
| **Post-Tool Use** | `PostToolUse` | `PostToolUse` | `postToolUse` | `tool.execute.after` |
| **Stop / Idle** | `Stop` | `Stop` | `stop` | `session.idle` |
| **Session End** | `SessionEnd` | `SessionEnd` | *(unreliable)* | *(unreliable)* |

### 7.3 Agent-Specific Notes

**Claude Code:**
- Hooks are installed into `.claude/settings.json` and `.claude/hooks/`
- Full lifecycle support with reliable SessionEnd
- SessionEnd extraction is spawned as a **detached process** to avoid the 1.5-second hook timeout

**Codex:**
- Hooks are installed into `.codex/hooks.json` and `.codex/hooks/`
- Full lifecycle support including PreToolUse
- Config location differs from Claude Code (`.codex/` instead of `.claude/`)

**Cursor:**
- Hooks are installed into `.cursor/hooks.json` and `.cursor/hooks/`
- **No reliable `SessionEnd` event** — Cursor CLI does not fire an event when the process exits
- Extraction is triggered by an **N-accumulated-events checkpoint** (default: 10 tool calls), evaluated at `stop`
- For precise session-end flushing, users can use `dev-memo wrap cursor-agent <args>`

**OpenCode:**
- Plugin installed into `.opencode/plugins/dev-mem.ts` and `opencode.json`
- Uses `session.idle` event as a proxy for session end
- Turn-based extraction trigger

### 7.4 Hook Installation Files

When `dev-memo install` runs, it generates the following files:

| Agent | Config File | Hook Scripts |
|-------|------------|-------------|
| Claude Code | `.claude/settings.json` | `.claude/hooks/dev-mem-sessionstart.js`, `dev-mem-posttooluse.js`, `dev-mem-stop.js`, `dev-mem-sessionend.js` |
| Codex | `.codex/hooks.json` | `.codex/hooks/dev-mem-sessionstart.js`, `dev-mem-pretooluse.js`, `dev-mem-posttooluse.js`, `dev-mem-stop.js`, `dev-mem-sessionend.js` |
| Cursor | `.cursor/hooks.json` | `.cursor/hooks/dev-mem-sessionstart.js`, `dev-mem-pretooluse.js`, `dev-mem-posttooluse.js`, `dev-mem-stop.js` |
| OpenCode | `opencode.json` | `.opencode/plugins/dev-mem.ts` |

### 7.5 Hook Failure Handling

Hooks are **best-effort observers** and must never terminate or disrupt the host agent:

| Failure Scenario | Behavior |
|-----------------|----------|
| Malformed JSON input | Logged to stderr, hook exits successfully |
| Unsupported event name | Logged and ignored |
| Missing/wrong-type `session_id` | Logged and ignored |
| Out-of-order events (tool call before SessionStart) | Captured with supplied session ID |
| SessionEnd without prior SessionStart | Logged, extraction not triggered |
| SQLite unavailable/corrupt | Hook logs failure and no-ops |
| Duplicate SessionEnd delivery | Harmless — extraction lock prevents re-processing |

---

## 8. CLI Interface

**Binary:** `dev-memo`

### 8.1 Command Reference

| Command | Purpose | Example |
|---------|---------|---------|
| `dev-memo install` | Detect agents, wire hooks, create `.dev-mem/` | `dev-memo install` |
| `dev-memo status` | Show graph size, lifecycle breakdown, last capture | `dev-memo status` |
| `dev-memo query "<text>"` | Preview what context would be injected for a task | `dev-memo query "optimize database queries"` |
| `dev-memo inspect <node-id>` | Full detail of a single node | `dev-memo inspect c4a1e9b2-...` |
| `dev-memo extract <session>` | Manually trigger extraction | `dev-memo extract sess_001` |
| `dev-memo wrap <cmd> [args]` | Run a command and flush events on exit | `dev-memo wrap cursor-agent` |
| `dev-memo uninstall [--purge]` | Remove hooks; `--purge` deletes `.dev-mem/` | `dev-memo uninstall --purge` |

### 8.2 Example Outputs

**`dev-memo status`:**
```
Nodes:
- Decision: 4
- FailedApproach: 1
- Constraint: 2
- Convention: 1

Total Nodes: 8

Lifecycle States:
- active: 6
- observed: 2

Last capture: 2026-09-30T15:20:14.120Z
```

**`dev-memo inspect <node-id>`:**
```
id:              c4a1e9b2-38d1-419b-a01f-0b61e27a7c11
type:            Constraint
lifecycle_state: active
title:           SQLite connection must be closed in finally blocks
content:         Unclosed connections prevent file deletion on Windows.
created_at:      2026-09-30T14:00:00.000Z
updated_at:      2026-09-30T14:00:00.000Z

evidence:
  commit:     4e2f81a
  files:      core/graph/index.ts, tests/setup.ts
  session_id: sess_1727708400
  agent:      claude-code
  timestamp:  2026-09-30T14:00:00.000Z
  confidence: 0.95

lifecycle_history:
  2026-09-30T14:00:00.000Z  (created) → active

edges:
  [constrains] → node-db-migration-01
```

---

## 9. Evaluation Methodology & Results

### 9.1 Evaluation Design

Dev-Mem's evaluation uses a fixed sample repository with a sequence of 12 interdependent tasks where later tasks genuinely depend on knowledge from earlier ones. Each sequence is run with Dev-Mem **OFF** and **ON**, and results are compared.

**Required metrics (from specification §11):**

1. **Redundant discovery avoided** — did the agent re-investigate something already known?
2. **Regression-repeat rate** — how often does an agent re-attempt a known failed approach?
3. **Net token delta** — (tokens spent on capture + retrieval) − (tokens saved by avoided rediscovery)
4. **Task success rate** — with vs. without Dev-Mem
5. **Time-to-completion** — wall-clock comparison

### 9.2 V1 Results (Single-Agent, Claude Code)

**Date:** 2026-09-18 | **Tasks:** 12 | **Agent:** Claude Code only

| Metric | Dev-Mem OFF | Dev-Mem ON | Delta |
|--------|-------------|------------|-------|
| Redundant discoveries | 13 events | 0 events | **13 eliminated (100%)** |
| Regression repeat rate | 8.3% | 0.0% | **Fully blocked** |
| Net token delta | 4,781 | 4,219 | **+562 tokens saved** |
| Task success rate | 100% | 100% | Parity |
| Injection overhead | — | 1,501 tokens total | Plateaus, does not grow unbounded |

### 9.3 V2 Results (Cross-Agent, Claude Code → Codex)

**Date:** 2026-09-21 | **Tasks:** 12 (Tasks 1–6: Claude Code, Tasks 7–12: Codex)

| Metric | Dev-Mem OFF | Dev-Mem ON | Delta |
|--------|-------------|------------|-------|
| Redundant discoveries | 13 events | 0 events | **13 eliminated (100%)** |
| Regression repeat rate | 8.3% | 0.0% | **Fully blocked** |
| Net token delta | 4,661 | 4,099 | **+562 tokens saved** |
| Task success rate | 100% | 100% | Parity |
| Cross-agent nodes transferred | N/A | **17 nodes** | Claude Code → Codex |
| Cross-agent regression fired | N/A | **Yes** | Task 7 |

### 9.4 Token Breakdown (V2)

| Component | OFF | ON |
|-----------|-----|-----|
| Base (system + task prompt + response) | 2,598 | 2,598 |
| Context injection overhead | — | 1,501 |
| Rediscovery exchanges (agent re-derives knowledge) | 2,063 | — |
| **Total** | **4,661** | **4,099** |

### 9.5 Cross-Agent Regression Intelligence Detail

- **FailedApproach node** (SQLite rejected): written by `claude-code` in Task 2
- **Re-attempt:** Task 7, executed by `codex`
- **ON mode:** Codex was warned before repeating the failure
- **OFF mode:** No mechanism — agent re-derived from scratch (168 rediscovery tokens)

### 9.6 Per-Task Token Breakdown

| # | Agent | Task | OFF Total | ON Total | Savings |
|---|-------|------|-----------|----------|---------|
| 1 | claude-code | Initial Architecture | 233 | 233 | 0 |
| 2 | claude-code | Failed Approach — SQLite | 439 | 292 | 147 |
| 3 | claude-code | Implement In-Memory Store | 338 | 322 | 16 |
| 4 | claude-code | Add REST API Endpoints | 369 | 315 | 54 |
| 5 | claude-code | Error Handling Discovery | 490 | 310 | 180 |
| 6 | claude-code | Apply Error Handling | 393 | 305 | 88 |
| 7 | **codex** | Re-attempt SQLite (regression) | 371 | 334 | 37 |
| 8 | **codex** | Validation Convention | 446 | 381 | 65 |
| 9 | **codex** | Add Input Validation | 355 | 375 | -20 |
| 10 | **codex** | Missing Authentication | 281 | 370 | -89 |
| 11 | **codex** | Add Authentication | 344 | 411 | -67 |
| 12 | **codex** | Refactor for Consistency | 602 | 451 | 151 |

> **Note:** Tasks 9–11 show negative per-task savings because the injection overhead exceeds rediscovery cost for those specific tasks. However, the **cumulative** net token delta remains positive (+562) because earlier tasks with high rediscovery cost dominate the total.

---

## 10. Use Case Guide

### 10.1 Solo Developer — Multi-Session Projects

**Scenario:** A solo developer works on a project across multiple terminal sessions over days or weeks. Between sessions, the developer forgets which approaches were tried, which constraints exist, and which bugs were already diagnosed.

**Dev-Mem workflow:**

1. Install once: `npm install -g dev-memo && dev-memo install`
2. Work normally in Claude Code (or any supported agent)
3. End the session. Dev-Mem extracts knowledge in the background.
4. Next session: Dev-Mem injects relevant decisions and constraints. Agent immediately has context.
5. If the agent attempts a previously failed approach, Regression Intelligence fires a warning.

**Impact:** Zero manual context prompting. No copy-pasting "here's what we decided last time."

### 10.2 Agent Switching — Claude Code to Cursor to Codex

**Scenario:** A developer uses Claude Code for terminal-heavy backend work, switches to Cursor for frontend work, and occasionally uses Codex for batch refactoring. Each tool has zero knowledge of what the others did.

**Dev-Mem workflow:**

1. Install hooks for all agents: `mkdir .cursor .codex -ea 0 && dev-memo install`
2. Work in Claude Code — decisions recorded
3. Switch to Cursor — same decisions automatically injected
4. Switch to Codex — same decisions + Cursor's new constraints injected
5. A FailedApproach from Claude Code blocks Codex from repeating it

**Impact:** Knowledge follows the project, not the tool.

### 10.3 Debugging Regression Prevention

**Scenario:** An agent spent 20 minutes debugging a specific error. It tried 3 approaches, found the root cause, and fixed it. Two weeks later, a different agent encounters a similar issue in the same file and starts with the exact same failing approach.

**Dev-Mem workflow:**

1. Session 1: Dev-Mem records the FailedApproach nodes with file evidence
2. Session N: Agent edits the same file → PostToolUse hook fires → Regression Intelligence checks the file against FailedApproach nodes → Warning injected before the agent proceeds

**Impact:** The agent skips the 3 failed approaches and goes directly to the working solution.

### 10.4 Architectural Decision Persistence

**Scenario:** The team decides to use a specific authentication pattern, database driver, or API structure. This decision is made conversationally in an agent session but never written down formally.

**Dev-Mem workflow:**

1. Agent session discusses and implements the architecture
2. Dev-Mem extracts a `Decision` node with the rationale and file evidence
3. Future sessions receive: `[DECISION] Use Firebase Admin for server-side auth (confidence: 0.94, commit a1b2c3d)`
4. Any agent working on auth files is reminded of the established pattern

**Impact:** Architecture decisions survive without requiring wiki pages or ADR documents.

### 10.5 Inspecting and Querying Project Knowledge

**Scenario:** A developer wants to understand what Dev-Mem knows about their project before starting a new feature.

```bash
# What context would the agent get for this task?
dev-memo query "implement user authentication"

# How many knowledge nodes exist?
dev-memo status

# Full detail on a specific constraint
dev-memo inspect <node-id>
```

---

## 11. Current Gaps & Limitations

### 11.1 Detection-Based Installation

Dev-Mem's `install` command detects agent directories (`.claude/`, `.cursor/`, `.codex/`) to decide which hooks to install. **Neither Codex nor Cursor automatically create these directories.** If no agent directory is found, Dev-Mem defaults to Claude Code only. Users must manually create the directories before installing hooks for those agents.

**Mitigation needed:** `dev-memo install --agent codex` or `dev-memo install --all` to create directories automatically.

### 11.2 No Embedding-Based Retrieval

Retrieval scoring uses Jaccard similarity on tokenized text — a bag-of-words approach. This works for exact and near-exact keyword matches but misses semantic similarity. "optimize database performance" would not match a node titled "PostgreSQL query tuning" unless they share literal tokens.

**Trade-off:** Zero external dependencies and no embedding model requirement. Adequate for V1/V2 graph sizes (< 100 nodes).

### 11.3 No Symbol-Level Grounding

Knowledge nodes cite file paths and commits, but not specific functions, classes, or symbols. A node about a function `validateAuth()` in `src/auth.ts` is linked to the file, not the symbol. If `validateAuth()` is renamed but the file persists, the node is not flagged as stale.

**Status:** Deferred to V3 (conditional on evidence that file-level grounding is insufficient).

### 11.4 Cursor SessionEnd Reliability

Cursor's CLI does not reliably fire a `SessionEnd` event when the process exits. Dev-Mem compensates with an N-accumulated-events checkpoint trigger, but this means extraction may be delayed or skipped if the user exits before the threshold is reached.

**Mitigation:** `dev-memo wrap cursor-agent <args>` provides reliable end-of-session extraction.

### 11.5 No Team / Multi-Developer Sync

`.dev-mem/` is gitignored by default. Knowledge is strictly per-machine. There is no mechanism for sharing or merging knowledge graphs across team members.

### 11.6 SQLite as Graph Backend

SQLite with tables + recursive CTEs is unvalidated against embedded graph databases (e.g., Kùzu) for Dev-Mem's specific access pattern: small local graphs with frequent relevance-ranked traversal. Performance is adequate for current graph sizes but may need re-evaluation at scale.

### 11.7 No Automatic Memory Pruning

Old, low-confidence, or rarely-retrieved nodes are never automatically deleted. The graph grows monotonically. Staleness detection marks nodes as `stale` but does not remove them.

### 11.8 Single Extraction LLM Call

Extraction uses a single batched LLM call over the entire session event log. For very long sessions (hundreds of tool calls), the event log may exceed the context window of smaller models.

---

## 12. Roadmap & Vision

### 12.1 Immediate Next Steps

| Priority | Item | Description |
|----------|------|-------------|
| **P0** | CLI `--agent` flag | `dev-memo install --agent codex` automatically creates the directory and wires hooks, eliminating the manual `mkdir` step |
| **P0** | CLI `--all` flag | `dev-memo install --all` installs hooks for every supported agent regardless of existing directories |
| **P1** | Memory pruning / decay | Automatic garbage collection of old, low-confidence, never-retrieved nodes |
| **P1** | Windsurf / Aider adapters | Expand agent support to cover the broader AI coding tool ecosystem |
| **P2** | Embedding-based retrieval | Optional semantic similarity scoring using local embedding models (e.g., via Ollama) |

### 12.2 V3 — Symbol-Level Grounding (Conditional)

V3 should only begin if V1/V2 evaluation data shows file/commit-level grounding is insufficient. This is a data-driven gate, not a default next step.

| Feature | Description |
|---------|-------------|
| Tree-sitter integration | Symbol-level provenance for one language (TypeScript/JavaScript first) |
| Symbol-aware staleness | Flag a node stale when its referenced function/class is renamed or removed |
| Symbol-level graph proximity | Retrieval ranking uses symbol-graph distance, not just file-path overlap |

### 12.3 Long-Term Vision

| Capability | Description |
|-----------|-------------|
| **Team knowledge sync** | Opt-in git-tracked `.dev-mem/` for teams that want shared project knowledge |
| **Graph pruning strategies** | Time-based decay, access-frequency weighting, confidence thresholds |
| **Multi-repo constraint propagation** | Monorepo-aware knowledge that propagates constraints across packages |
| **Evaluation at scale** | Benchmark against 50+ node graphs and 100+ task sequences |
| **Plugin ecosystem** | Third-party adapters for Windsurf, Aider, Continue.dev, Roo Code, Gemini CLI |

### 12.4 What Dev-Mem Will Never Be

| Not building | Rationale |
|-------------|-----------|
| Hosted/cloud service | Contradicts local-first constraint |
| General-purpose AI memory API | Dev-Mem is coding-agent-specific |
| Skill/procedure distillation | Saturated sub-category; distracts from the core knowledge-graph problem |
| Full validation/audit engine | Minimal existence/contradiction checks are in scope; exhaustive fact-checking is not |
| GUI/desktop application | Integration points are all CLI/terminal-native |

---

## 13. Glossary

| Term | Definition |
|------|-----------|
| **Development State** | The core abstraction — a typed, evidence-backed, lifecycle-aware graph of claims about the project. Not "memory." |
| **Node** | A single typed knowledge item: Decision, FailedApproach, Constraint, Discovery, Convention, or OpenIssue. |
| **Evidence** | Mandatory provenance attached to every node: commit, files, session, agent, confidence. |
| **Edge** | A directed relationship between two nodes: supersedes, contradicts, depends-on, discovered-from, resolves. |
| **Regression Intelligence** | Active detection of an agent about to repeat a known failed approach. Dev-Mem's flagship feature. |
| **Net token delta** | Core success metric: tokens spent on Dev-Mem operations minus tokens saved by avoided rediscovery. Must be positive. |
| **Adaptive budget** | Token budget formula (`nodeCount × 18`, clamped 80–2000) that maintains selection pressure at any graph size. |
| **Deterministic capture** | Zero-LLM-cost recording of git state, file touches, and tool calls. |
| **Batched extraction** | The single LLM call per session checkpoint that converts raw events into typed knowledge nodes. |
| `.dev-mem/` | Local, per-project, gitignored-by-default directory holding the graph store, event log, and config. |
| **Hook** | A script that an agent calls at lifecycle boundaries (SessionStart, PostToolUse, etc.). Dev-Mem installs these into each agent's configuration. |

---

*End of technical report. Version 0.2.1, September 2026.*
