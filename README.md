<div align="center">

<pre>
██████╗ ███████╗██╗   ██╗    ███╗   ███╗███████╗███╗   ███╗
██╔══██╗██╔════╝██║   ██║    ████╗ ████║██╔════╝████╗ ████║
██║  ██║█████╗  ██║   ██║    ██╔████╔██║█████╗  ██╔████╔██║
██║  ██║██╔══╝  ╚██╗ ██╔╝    ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║
██████╔╝███████╗ ╚████╔╝     ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║
╚═════╝ ╚══════╝  ╚═══╝      ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝
</pre>

**Persistent local knowledge store for AI coding agents**
<p align="center">
  <i>Preserves development context and catches repeated mistakes across Claude Code, Cursor, Codex, OpenCode, and Antigravity.</i>
</p>

[![npm version](https://img.shields.io/npm/v/dev-memo?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/dev-memo)
[![License: MIT](https://img.shields.io/badge/License-MIT-1f6feb?style=for-the-badge&logo=open-source-initiative&logoColor=white)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)


</div>

---

Dev-Mem gives your AI coding agents (**Claude Code, Codex, Cursor, OpenCode, Antigravity, and MCP tools**) a persistent, evidence-backed engineering memory that survives session restarts, agent switches, and parallel Git worktrees.

- **Stop repeating solved investigations:** Relevant architectural decisions, constraints, and discoveries inject automatically at session start and prompt time via SQLite FTS5 + BM25 search.
- **Catch regressions before editing broken paths:** Mid-session file guards warn when you touch files tied to past `FailedApproach` rollbacks — gated by topical similarity and deduplicated per session.
- **Day-one memory with zero extra API keys:** `dev-memo init` wires hooks + MCP, seeds starter rules from Git reverts and `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursorrules` at `$0` cost, and extracts new session knowledge using your already-authenticated host CLI (`claude`, `codex`, `agy`) — or optional API keys / local Ollama.
- **Human governance & Git team sync:** Review pending memories (`dev-memo review`), sync compact tombstoned state (`.dev-mem/shared.jsonl` + git-diffable `.dev-mem/MEMORY.md`), comment on GitHub PRs (`.github/actions/pr-context`), track ROI (`dev-memo stats`), and inspect the graph offline (`dev-memo view`).
- **100% local & lightweight:** Zero background daemons, zero open network ports, `better-sqlite3` as the sole runtime dependency, and automatic secret/privacy redaction.

---

## Requirements

- Node.js 22+
- A project using **Claude Code**, **Codex**, **Cursor**, **OpenCode**, or **Antigravity** (or any MCP-compatible client)
- An extraction backend — **no extra API key needed** if you already have one of these CLIs authenticated on your `PATH`:
  - `claude` (Claude Code CLI)
  - `codex` (Codex CLI)
  - `agy` (Antigravity CLI)
- Optional direct API key / local model fallback:
  - `ANTHROPIC_API_KEY` (default: `claude-haiku-4-5`)
  - `OPENAI_API_KEY` (default: `gpt-5-mini`)
  - `GEMINI_API_KEY` or `GOOGLE_API_KEY` (default: `gemini-3.5-flash`)
  - `DEV_MEM_LLM_BASE_URL` for Ollama, Groq, OpenRouter, LM Studio, or DeepSeek (no key required for Ollama)

---

## 30-Second Quick Start (`dev-memo init`)

```bash
npm install -g dev-memo
dev-memo init
```

`dev-memo init` sets up your repo in one command:
1. Detects installed agents (or infers `claude-code` / `codex` / `antigravity` from your `PATH`; pass explicit names like `dev-memo init cursor` or `dev-memo init antigravity` if needed).
2. Wires lifecycle hooks and updates `.gitignore` (`.dev-mem/*` ignored locally while un-ignoring `.dev-mem/shared.jsonl` and `.dev-mem/MEMORY.md`).
3. Registers `dev-memo mcp` in `.mcp.json`, `.cursor/mcp.json`, `.agents/mcp_config.json`, and `opencode.json` (or `.opencode/opencode.json`).
4. Verifies your extraction backend (`cli-claude`, `cli-codex`, `cli-agy`, API key, or Ollama).
5. Runs `dev-memo bootstrap` to mine past Git reverts and repository rules (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*`, `.agents/rules/*.md`, `.github/copilot-instructions.md`) so your very first prompt already has context.

*(Pass `--no-mcp` or `--no-bootstrap` to skip those steps, or use `dev-memo install [agent...]` to manage only hooks.)*

| Agent | Hooks Installed |
|---|---|
| `claude-code` (default fallback) | `.claude/settings.json` + `.claude/hooks/` (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`) |
| `codex` | `.codex/hooks.json` + `.codex/hooks/` (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`) |
| `cursor` | `.cursor/hooks.json` + `.cursor/hooks/` (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`) |
| `opencode` | `.opencode/plugins/dev-mem.ts` + `opencode.json` (`chat.message`, `tool.execute.after`, `session.idle`) |
| `antigravity` (alias `agy`) | `.agents/hooks.json` + `.agents/hooks/` (`SessionStart`, `PreInvocation`, `PreToolUse`, `PostToolUse`, `Stop`) |

If multiple agent directories exist, hooks are installed for all of them. Running `dev-memo install` again is safe and idempotent.

---

## CLI commands

### `dev-memo stats` & `dev-memo view`

Inspect local ROI telemetry and explore your knowledge graph offline with zero background servers:

```bash
# Show nodes, verification ratio, injections, warnings surfaced, and extraction health
dev-memo stats
dev-memo stats --json

# Generate self-contained offline HTML graph explorer at .dev-mem/report.html
dev-memo view
dev-memo view --open
```

### `dev-memo bootstrap [--from <file>]`

Mines recent Git revert commits (`FailedApproach` nodes) and repository instruction files (`AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `GEMINI.md`, `.agents/rules/*.md`, `.cursorrules`, `.cursor/rules/*`, `.github/copilot-instructions.md`) into starter `Constraint` and `Convention` nodes with zero LLM API cost. Automatically deduplicates against existing graph nodes so re-running is safe.

```bash
dev-memo bootstrap
# Auto-discover and import Claude Code's local project MEMORY.md:
dev-memo bootstrap --claude-memory
# Or include any specific markdown file:
dev-memo bootstrap --from docs/architecture-notes.md
```

Example output:
```
Bootstrapped 7 memory node(s) (reverts: 2, rules: 5, skipped duplicates: 0).
```

---

### `dev-memo status`

Shows the current state of the local knowledge graph.

```
dev-memo status
```

Example output:

```
Nodes:
- Decision: 3
- FailedApproach: 1
- Discovery: 2
- Convention: 4

Total Nodes: 10

Lifecycle States:
- observed: 6
- active: 4

Last capture: 2026-09-18T14:22:07.031Z
Last extraction: 2026-09-18T14:22:12.410Z — ok (3 nodes via cli-claude)
```

If no `.dev-mem/graph.sqlite` exists yet (before the first extraction completes), it prints `GraphStore Error: ...` — this is normal before the first session ends.

---

### `dev-memo doctor [--live]`

Checks git repository, hook currency, install-path resolution, and LLM configuration (add `--live` to make a live test call to the configured LLM provider).

```bash
dev-memo doctor
# or test LLM connectivity:
dev-memo doctor --live
```

---

### `dev-memo uninstall`

Removes all Dev-Mem hooks from detected agent configurations. Leaves `.dev-mem/` data intact.

```
dev-memo uninstall
```

To remove hooks **and** delete all stored data:

```
dev-memo uninstall --purge
```

`--purge` deletes the entire `.dev-mem/` directory. This is not reversible unless you have a backup.

---

### `dev-memo wrap <command> [args...]`

Runs a command and flushes any remaining captured events through extraction when it exits. Primarily useful for Cursor, which doesn't fire a reliable `SessionEnd` event.

```
dev-memo wrap cursor-agent --headless
```

Without `wrap`, Cursor's extraction fires every 10 tool calls (configurable). With `wrap`, extraction also runs on clean exit, regardless of whether the threshold was hit.

Example output on exit:

```
[dev-memo] Wrapping complete. Flushing remaining events for session sess_abc123...
```

---

### `dev-memo extract <session-id>`

Manually triggers extraction for a session ID. Normally called automatically by the hooks — only useful if a hook failed to fire or you're debugging.

```
dev-memo extract sess_abc123
```

If extraction is already running or has already completed for that session, it prints `Extraction skipped` and exits 0.

---

### `dev-memo prune`

Cleans `.dev-mem/events.jsonl` by removing recorded events belonging to sessions that have already completed extraction into the SQLite knowledge graph. Active and unextracted session events are preserved.

```bash
dev-memo prune
```

Example output:
```
Pruned 42 extracted event(s); 12 active event(s) kept.
```

Extraction also runs `prune` automatically after every successful session extraction to keep event logs compact and disk usage minimal.

---

### `dev-memo sync`

Bidirectionally syncs local curated engineering memory (`active` and `verified` nodes) with the git-friendly `.dev-mem/shared.jsonl` file.

```bash
dev-memo sync
```

Example output:
```
Synced .dev-mem/shared.jsonl (imported: 2, updated: 1, exported: 5 active/verified nodes).
```

#### Team Knowledge Sharing via Git

While Dev-Mem's internal SQLite database (`.dev-mem/graph.sqlite`) and raw event logs (`.dev-mem/events.jsonl`) remain strictly machine-local and gitignored (`.dev-mem/*`), `.dev-mem/shared.jsonl` and `.dev-mem/MEMORY.md` are explicitly un-ignored (`!.dev-mem/shared.jsonl`, `!.dev-mem/MEMORY.md`). Teams share curated architectural decisions, conventions, constraints, and failure warnings simply by committing them into git:

1. **Deterministic line format:** Records in `.dev-mem/shared.jsonl` are sorted by ID, and `.dev-mem/MEMORY.md` is updated alongside every `dev-memo sync` so pull requests remain human-reviewable.
2. **Noise isolation:** Local scratch observations (`observed` state) stay local; curated (`active` or `verified`) knowledge and their `superseded`/`stale` retirements sync cleanly across teammates using `updated_at` last-writer-wins.
3. **Automatic session-start import:** When teammates pull git changes (`git pull`), Dev-Mem automatically imports incoming nodes and retirements into their local SQLite store on the next agent `SessionStart`.

---

### Human Curation & Markdown Projection

Inspect, review, approve, edit, retire, and export local knowledge nodes directly from the terminal (all node commands accept 8-char short ID prefixes):

```bash
# List and filter stored memories (shows [8-char] short IDs)
dev-memo list --state observed --type Decision

# Search titles, contents, and linked files
dev-memo search "postgresql"

# Interactive review TUI for pending observed nodes ([a]pprove / [e]dit / [s]kip / [d]iscard / [q]uit)
dev-memo review

# Scriptable single-node curation (using short ID prefixes)
dev-memo inspect 3f2a1b4c
dev-memo approve 3f2a1b4c
dev-memo edit 3f2a1b4c --title "Use PostgreSQL 16" --content "Rationale..."
dev-memo forget 3f2a1b4c --reason "Replaced by SQLite in V2"

# Generate git-diffable .dev-mem/MEMORY.md and optionally refresh bounded AGENTS.md summary
dev-memo export --md --agents-md

# Generate PR review context or auto-verify touched nodes on green merge (used by GitHub Action)
dev-memo pr-context --base origin/main --head HEAD
```

#### Parallel Worktree Sharing & Live Sibling Inbox

When you run parallel coding agents inside `git worktree` checkouts, Dev-Mem resolves `git rev-parse --git-common-dir` automatically so every worktree shares one SQLite WAL graph and `events.jsonl` in the main repository root (override with `DEV_MEM_ISOLATE_WORKTREE=1`). Recent relevant discoveries captured by sibling sessions within the last 2 hours automatically receive a **live inbox** priority boost across active worktrees.

#### GitHub PR Context Action

Add Dev-Mem warnings and constraints directly to GitHub Pull Requests (and auto-verify touched nodes when PRs merge cleanly) using the bundled composite action at `.github/actions/pr-context`:

```yaml
- uses: HarsH-1877/Dev-Mem/.github/actions/pr-context@main
  with:
    base-ref: origin/${{ github.base_ref }}
    verify-on-merge: "false"
```

---

### `dev-memo query "<text>"`

Manually runs retrieval for a given task description and prints the context a session would receive. Useful for debugging what's in the graph or checking that extraction captured something correctly.

```
dev-memo query "add authentication to the API"
```

Example output:

```
<dev_mem_context>
Relevant context from previous development sessions:

[DECISION] (confidence: 0.91, observed today)
Use Firebase Auth for server-side authentication.
Evidence: commit a1b2c3, src/auth/session.ts

[FAILED APPROACH] (confidence: 0.88, observed today)
Client-side JWT verification caused session inconsistency.
Evidence: commit b3c4d5, src/auth/legacy.ts
</dev_mem_context>
```

Uses the same adaptive budget and relevance scoring as the live SessionStart hook. Returns `No relevant context found in graph.` if the graph is empty or nothing scores above the budget threshold.

---

### `dev-memo inspect <node-id>`

Prints the full detail of a single knowledge node — all fields, evidence, lifecycle history, and any edges connecting it to other nodes.

```
dev-memo inspect <uuid>
```

Get node IDs from `dev-memo list` / `dev-memo search` (shows 8-character short IDs that work directly with `inspect`, `approve`, `edit`, and `forget`) or from `dev-memo query`. Example output:

```
id:              3f2a1b4c-...
type:            Decision
lifecycle_state: observed
title:           Use Firebase Auth for server-side authentication
content:         Firebase Admin validates tokens server-side, removing client-side concerns.
created_at:      2026-09-18T14:22:07.031Z
updated_at:      2026-09-18T14:22:07.031Z

evidence:
  commit:     abc1234def5678901234567890abcdef12345678
  files:      src/auth/session.ts
  session_id: sess_abc123
  agent:      claude-code
  timestamp:  2026-09-18T14:22:07.031Z
  confidence: 0.91

lifecycle_history:
  2026-09-18T14:22:07.031Z  (created) → observed

edges:
  [contradicts] → <uuid-of-conflicting-node>
```

Returns exit code 1 with `Node not found: <id>` if the ID doesn't exist.

---

### `dev-memo mcp`

Runs a zero-daemon Model Context Protocol (MCP) server communicating via standard JSON-RPC 2.0 over `stdio`. It exposes Dev-Mem's local SQLite engineering memory and active regression protection directly as native MCP tools to any compliant client.

#### Zero-Daemon Architecture
Unlike traditional MCP servers that require long-running background services or open localhost HTTP/WebSocket ports, `dev-memo mcp`:
- Requires **zero background daemons** and **zero open ports**.
- Is spawned on-demand by your IDE or agent as a child process.
- Communicates directly over standard input/output (`stdio`) and terminates cleanly when the client disconnects.
- Operates directly against the project's local `.dev-mem/graph.sqlite`.

#### Exposed Tools

| Tool | Purpose | Key Arguments |
|---|---|---|
| `dev_mem_query` | Search project engineering memory (decisions, failed approaches, constraints, conventions, discoveries, open issues) for relevant context. | `query` (string, required), `files` (string[], optional) |
| `dev_mem_check_regression` | Pre-flight check: detects if files about to be modified overlap with known `FailedApproach` nodes in project history. | `files` (string[], required) |
| `dev_mem_remember` | Directly record durable engineering knowledge into the local graph with zero LLM cost. | `type` (Decision, FailedApproach, Constraint, Discovery, Convention, OpenIssue), `title`, `content`, `files`, `symbols` (optional) |
| `dev_mem_resolve` | Transition an existing node (such as a fixed `OpenIssue` or replaced `Decision`) to `superseded` or `stale`. | `node_id` (string, required), `to_state` (`superseded` \| `stale` \| `active` \| `verified`) |

#### Client Configuration

##### 1. Claude Desktop
Add to your `claude_desktop_config.json` (on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, on Windows: `%APPDATA%\Claude\claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "dev-memo": {
      "command": "npx",
      "args": ["-y", "dev-memo", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

##### 2. Claude Code
Register `dev-memo` via the Claude Code CLI:
```bash
claude mcp add dev-memo -- npx -y dev-memo mcp
```
Or add to your `.claude.json` / settings:
```json
{
  "mcpServers": {
    "dev-memo": {
      "command": "npx",
      "args": ["-y", "dev-memo", "mcp"]
    }
  }
}
```

##### 3. Cursor
In Cursor Settings $\rightarrow$ Features $\rightarrow$ MCP Servers $\rightarrow$ "Add New MCP Server":
- **Name:** `dev-memo`
- **Type:** `command`
- **Command:** `npx -y dev-memo mcp`

Or in `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "dev-memo": {
      "command": "npx",
      "args": ["-y", "dev-memo", "mcp"]
    }
  }
}
```

##### 4. OpenCode
In your `opencode.json`:
```json
{
  "mcp": {
    "servers": {
      "dev-memo": {
        "command": "npx",
        "args": ["-y", "dev-memo", "mcp"]
      }
    }
  }
}
```

##### 5. Antigravity
`dev-memo init antigravity` automatically writes `.agents/mcp_config.json`:
```json
{
  "mcpServers": {
    "dev-memo": {
      "command": "npx",
      "args": ["-y", "dev-memo", "mcp"]
    }
  }
}
```

---

## Configuration

Create `.dev-mem/config.yml` at the project root to override defaults.

**Currently supported options:**

```yaml
# Number of completed tool calls in a Cursor session before extraction
# is triggered automatically. Must be a positive integer.
# Default: 10. Has no effect on Claude Code or Codex (they use SessionEnd).
extraction_event_threshold: 10

# Optional LLM overrides (defaults: claude-haiku-4-5, gpt-5-mini, gemini-3.5-flash)
# llm_provider: anthropic   # "anthropic" | "openai" | "gemini" | "openai-compatible"
# llm_model: claude-haiku-4-5
# llm_base_url: http://localhost:11434/v1
# llm_api_key: sk-...
```

The file is optional — if it doesn't exist or keys are missing, the defaults are used. LLM provider and model settings can also be configured via environment variables (`DEV_MEM_LLM_PROVIDER`, `DEV_MEM_LLM_MODEL`, `DEV_MEM_LLM_BASE_URL`, `DEV_MEM_LLM_API_KEY`).

Token budget settings are not yet user-configurable through `config.yml`. The retrieval budget is calculated automatically from graph size (`nodeCount × 18`, clamped between 80 and 2000 tokens).

---

## What happens automatically after install

Once hooks are installed, every agent session does this without any manual steps:

**At session start** — Dev-Mem reads the local graph, scores stored knowledge nodes against the current working-tree state (which files are modified, what the session title is), selects the highest-scoring nodes within the token budget, and injects them into the agent's context. Per-session deduplication tracks all injected nodes so subsequent turns never repeat them. If any stored `FailedApproach` nodes match files you're about to work on, a regression warning is injected first.

**At prompt submission (Claude Code `UserPromptSubmit`, Antigravity `PreInvocation`, OpenCode `chat.message`)** — As the task evolves across turns, Dev-Mem filters strictly on topical relevance (`minRelevance >= 0.08`) against the submitted prompt text and applies type-aware freshness decay (`Constraint`/`Convention` persist long-term while ephemeral `Discovery`/`OpenIssue` decay faster). Built-in per-session deduplication (`.dev-mem/sessions/<session-id>.injected.json`) ensures only new, un-injected relevant nodes are injected once per session.

**During the session** — Every tool call (file writes, shell commands) is recorded to `.dev-mem/events.jsonl`. All events are scrubbed before storage: API keys (Anthropic, OpenAI, Gemini, GitHub, AWS, Slack, Bearer tokens, `.env` credentials) and `<private>...</private>` tags are automatically redacted. For Claude Code, Codex, and Antigravity (`PreToolUse`/`PostToolUse`), this includes pre- and post-execution context/regression checks (Antigravity `PreToolUse` returns `{"decision":"allow"}` with optional `additionalContext`). For Cursor, post-execution capture only. Mid-session regression checks also run on file writes, gated by topical similarity on partial file overlaps and deduplicated per session (`.dev-mem/sessions/<session-id>.warnings.json`) so hub files never trigger repeated warning spam.

**At session end (Claude Code, Codex, Antigravity `Stop`)** — Dev-Mem runs a deterministic compaction pass (stripping duplicate reads, collapsing consecutive status checks, and capping passing tool output) to reduce token overhead by 70–90%, followed by a single batched call (using your already-authenticated host CLI or configured API key) that extracts typed knowledge nodes and verifies surviving nodes only when corroborated by passing tests or commit advancement. Every run records its status and any errors to `.dev-mem/extraction.log` so diagnostics are always visible in `dev-memo status`.

**After N tool calls (Cursor)** — Same extraction step, triggered mid-session every N completed tool calls (default 10) rather than at session end.

The injected context looks like this:

```
[DECISION] (confidence: 0.91, observed today)
Use in-memory Map for task storage in V1.
Evidence: commit a1b2c3d, docs/architecture.md

[FAILED APPROACH] (confidence: 0.88, observed today)
Direct SQLite implementation — contradicts architecture decision.
Evidence: commit 9f8e7d6, src/store-sqlite.js

[CONVENTION] (confidence: 0.87, observed today)
All route handlers use try-catch with { error, code } JSON format.
Evidence: commit b2c3d4e, src/server.js
```

Each item includes confidence and recency so the agent can weight trust appropriately.

---

## Known limitations

**Cursor and OpenCode: no reliable session-end flush.** Cursor's `cursor-agent` CLI and OpenCode do not reliably fire a session-end event when the headless process exits. Dev-Mem compensates with turn-based checkpoints (extraction fires every 10 tool calls for Cursor, and on `session.idle` for OpenCode), but if a session ends abruptly, knowledge from that session is not extracted until the next checkpoint or until you run `dev-memo wrap`. The `dev-memo wrap <command> <args>` approach is the cleanest workaround.

**No automatic repair of corrupted local state.** If `.dev-mem/graph.sqlite` or `.dev-mem/events.jsonl` becomes corrupted (e.g. due to a crash mid-write or a full disk), Dev-Mem logs the failure and no-ops rather than attempting repair. To recover: delete the `.dev-mem/` directory and run `npx dev-memo install` again. You will lose accumulated graph state. There is no automatic backup.

**Team sharing via Git.** Dev-Mem keeps machine-specific SQLite files and event logs local (`.dev-mem/*` is gitignored), but allows team memory synchronization through `.dev-mem/shared.jsonl` (which is explicitly un-ignored). Teams share verified and active architectural decisions, conventions, and constraints by running `dev-memo sync` and committing `.dev-mem/shared.jsonl` to version control. Teammates receive updates automatically on their next agent `SessionStart`.



---

## How it works (brief)

Dev-Mem records deterministic events (git state, file touches, tool call logs) with zero LLM cost per event. At session end, one batched call turns that event log into typed knowledge nodes with evidence pointers. At the next session start and on prompts, a hybrid SQLite FTS5/BM25 + stemmed Jaccard scoring pass with symbol/directory weighting selects the most relevant nodes within the token budget and injects them as structured context.

The one-LLM-call-per-session design is deliberate: extraction is the only place an LLM is called. Capture, retrieval, and regression checks are all deterministic code with no API calls.

For the full design — node types, edge types, lifecycle states, evidence schema, scoring weights, retrieval budget formula, and evaluation results — see [`dev-mem-spec.md`](./dev-mem-spec.md) at the repo root.

---

## License

MIT


