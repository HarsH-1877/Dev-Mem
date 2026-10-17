<div align="center">
  
# Dev-Mem

**Persistent local knowledge store for AI coding agents**
<p align="center">
  <i>Preserves development context and catches repeated mistakes across Claude Code, Cursor, Codex, and OpenCode.</i>
</p>

[![npm version](https://img.shields.io/npm/v/dev-memo?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/dev-memo)
[![License: MIT](https://img.shields.io/badge/License-MIT-1f6feb?style=for-the-badge&logo=open-source-initiative&logoColor=white)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)


</div>

---

Dev-Mem gives AI coding agents (Claude Code, Codex, Cursor, OpenCode) a persistent local knowledge store that survives session restarts and agent switches. It records decisions, failed approaches, constraints, and discoveries your agent makes while coding, and injects the relevant ones at the start of each new session — so the next session doesn't re-investigate what the last one already figured out.

Everything stays on your machine. No server, no network dependency beyond your existing LLM API key.

---

## Requirements

- Node.js 22+
- An existing project with at least one of: `.claude/`, `.codex/`, or `.cursor/` already present (or a Claude Code project, which creates `.claude/` automatically)
- An LLM API key for the extraction step — any ONE of:
  - `ANTHROPIC_API_KEY` (Claude, default: `claude-haiku-4-5`)
  - `OPENAI_API_KEY` (OpenAI, default: `gpt-5-mini`)
  - `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini, default: `gemini-3.5-flash`)
  - `DEV_MEM_LLM_BASE_URL` pointed at any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter, LM Studio, DeepSeek) — no API key required for local Ollama

---

## Install

Install Dev-Mem globally to make the `dev-memo` command available everywhere:

```bash
npm install -g dev-memo
```

Then, run this once per project from the project root to wire the agent hooks:

```bash
dev-memo install
```
*(Or, if you prefer not to install globally, you can prefix all commands in this guide with `npx dev-memo`)*

Dev-Mem automatically detects which agent directories exist in your project. However, since agents like Codex and Cursor do not auto-create their directories in every repository by default, **you can explicitly specify your agent**:

```bash
dev-memo install codex
# or
dev-memo install cursor
```

| Agent Requested / Detected | What it installs |
|---|---|
| `claude-code` (or nothing found) | Claude Code hooks into `.claude/settings.json` and `.claude/hooks/` |
| `codex` | Codex hooks into `.codex/hooks.json` and `.codex/hooks/` |
| `cursor` | Cursor hooks into `.cursor/hooks.json` and `.cursor/hooks/` |
| `opencode` | OpenCode plugin into `.opencode/plugins/dev-mem.ts` and `opencode.json` |

If multiple agent directories exist, hooks are installed for all of them.

**Example output — Claude Code only:**

```
dev-memo hooks installed (agents: claude-code)
```

**Example output — with Cursor detected:**

```
dev-memo hooks installed (agents: claude-code, cursor)

[Notice for Cursor]: Cursor CLI lacks a reliable SessionEnd event.
Dev-Mem uses an N-accumulated-events trigger (default 10) instead.
For a perfect flush when exiting, run your agent via: dev-memo wrap cursor-agent <args>
```

Dev-Mem also creates `.dev-mem/` at the project root (gitignored by default) and adds `.dev-mem/` to `.gitignore` if it isn't already there.

**Reinstalling:** running `npx dev-memo install` again is safe — it won't duplicate hooks if they're already present.

### Upgrading from 0.2.x

Hook scripts changed format. After upgrading, run `dev-memo install` once in each project. `dev-memo status` warns you if old hooks are still present. Upgraded hooks contain no machine-specific paths and are safe to commit for your whole team.

---

## CLI commands

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

Get node IDs from `dev-memo status` (lists counts by type) or from `dev-memo query` output (each result includes the evidence commit; run query first to find candidates). Example output:

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

**At prompt submission (Claude Code `UserPromptSubmit`, OpenCode `chat.message`)** — As the task evolves across turns, Dev-Mem retrieves context scored against the submitted prompt text. Built-in per-session deduplication (`.dev-mem/sessions/<session-id>.injected.json`) ensures only new, un-injected relevant nodes (scoring above threshold) are injected, giving the agent fresh task-specific context without duplicate spam or wasted tokens.

**During the session** — Every tool call (file writes, shell commands) is recorded to `.dev-mem/events.jsonl`. All events are scrubbed before storage: API keys (Anthropic, OpenAI, Gemini, GitHub, AWS, Slack, Bearer tokens, `.env` credentials) and `<private>...</private>` tags are automatically redacted. For Claude Code and Codex, this includes both pre- and post-execution snapshots. For Cursor, post-execution only. Mid-session regression checks also run on file writes.

**At session end (Claude Code, Codex)** — Dev-Mem runs a deterministic compaction pass (stripping duplicate reads, collapsing consecutive status checks, and capping passing tool output) to reduce token overhead by 70–90%, followed by a single batched LLM call that extracts typed knowledge nodes from the session's compacted event log. Extracted nodes start in `observed` state. This call happens in a detached background process and doesn't block the agent.

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

**Single machine, local only.** `.dev-mem/` is gitignored by default. If you work across multiple machines or want to share knowledge graph state across a team, you would need to opt `.dev-mem/` into version control (`git add -f .dev-mem/` or remove it from `.gitignore`). There is no sync mechanism built in.



---

## How it works (brief)

Dev-Mem records deterministic events (git state, file touches, tool call logs) with zero LLM cost per event. At session end, one batched LLM call turns that event log into typed knowledge nodes with evidence pointers. At the next session start, a budget-constrained scoring pass selects the most relevant nodes from the graph (by topic similarity, freshness, confidence, and file proximity) and injects them as structured context.

The one-LLM-call-per-session design is deliberate: extraction is the only place an LLM is called. Capture, retrieval, and regression checks are all deterministic code with no API calls.

For the full design — node types, edge types, lifecycle states, evidence schema, scoring weights, retrieval budget formula, and evaluation results — see [`dev-mem-spec.md`](./dev-mem-spec.md) at the repo root.

---

## License

MIT


