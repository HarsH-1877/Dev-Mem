# Dev-Mem

Dev-Mem gives AI coding agents (Claude Code, Codex, Cursor) a persistent local knowledge store that survives session restarts and agent switches. It records decisions, failed approaches, constraints, and discoveries your agent makes while coding, and injects the relevant ones at the start of each new session — so the next session doesn't re-investigate what the last one already figured out.

Everything stays on your machine. No server, no network dependency beyond your existing LLM API key.

---

## Requirements

- Node.js 22+
- An existing project with at least one of: `.claude/`, `.codex/`, or `.cursor/` already present (or a Claude Code project, which creates `.claude/` automatically)
- An LLM API key for the extraction step — any ONE of:
  - `ANTHROPIC_API_KEY` (Claude)
  - `OPENAI_API_KEY` (GPT-4o / GPT-4o-mini)
  - `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini)
  - `DEV_MEM_LLM_BASE_URL` pointed at any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter, LM Studio, DeepSeek) — no API key required for local Ollama

---

## Install

Run this once per project, from the project root:

```
npx dev-mem install
```

Dev-Mem detects which agent directories exist and wires hooks accordingly:

| What it detects | What it installs |
|---|---|
| `.claude/` present (or nothing found) | Claude Code hooks into `.claude/settings.json` and `.claude/hooks/` |
| `.codex/` present | Codex hooks into `.codex/hooks.json` and `.codex/hooks/` |
| `.cursor/` present | Cursor hooks into `.cursor/hooks.json` and `.cursor/hooks/` |

If multiple agent directories exist, hooks are installed for all of them.

**Example output — Claude Code only:**

```
dev-mem hooks installed (agents: claude-code)
```

**Example output — with Cursor detected:**

```
dev-mem hooks installed (agents: claude-code, cursor)

[Notice for Cursor]: Cursor CLI lacks a reliable SessionEnd event.
Dev-Mem uses an N-accumulated-events trigger (default 10) instead.
For a perfect flush when exiting, run your agent via: dev-mem wrap cursor-agent <args>
```

Dev-Mem also creates `.dev-mem/` at the project root (gitignored by default) and adds `.dev-mem/` to `.gitignore` if it isn't already there.

**Reinstalling:** running `npx dev-mem install` again is safe — it won't duplicate hooks if they're already present.

---

## CLI commands

### `dev-mem status`

Shows the current state of the local knowledge graph.

```
dev-mem status
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

### `dev-mem uninstall`

Removes all Dev-Mem hooks from detected agent configurations. Leaves `.dev-mem/` data intact.

```
dev-mem uninstall
```

To remove hooks **and** delete all stored data:

```
dev-mem uninstall --purge
```

`--purge` deletes the entire `.dev-mem/` directory. This is not reversible unless you have a backup.

---

### `dev-mem wrap <command> [args...]`

Runs a command and flushes any remaining captured events through extraction when it exits. Primarily useful for Cursor, which doesn't fire a reliable `SessionEnd` event.

```
dev-mem wrap cursor-agent --headless
```

Without `wrap`, Cursor's extraction fires every 10 tool calls (configurable). With `wrap`, extraction also runs on clean exit, regardless of whether the threshold was hit.

Example output on exit:

```
[dev-mem] Wrapping complete. Flushing remaining events for session sess_abc123...
```

---

### `dev-mem extract <session-id>`

Manually triggers extraction for a session ID. Normally called automatically by the hooks — only useful if a hook failed to fire or you're debugging.

```
dev-mem extract sess_abc123
```

If extraction is already running or has already completed for that session, it prints `Extraction skipped` and exits 0.

---

### `dev-mem query "<text>"`

Manually runs retrieval for a given task description and prints the context a session would receive. Useful for debugging what's in the graph or checking that extraction captured something correctly.

```
dev-mem query "add authentication to the API"
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

### `dev-mem inspect <node-id>`

Prints the full detail of a single knowledge node — all fields, evidence, lifecycle history, and any edges connecting it to other nodes.

```
dev-mem inspect <uuid>
```

Get node IDs from `dev-mem status` (lists counts by type) or from `dev-mem query` output (each result includes the evidence commit; run query first to find candidates). Example output:

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

## Configuration

Create `.dev-mem/config.yml` at the project root to override defaults.

**Currently supported option:**

```yaml
# Number of completed tool calls in a Cursor session before extraction
# is triggered automatically. Must be a positive integer.
# Default: 10. Has no effect on Claude Code or Codex (they use SessionEnd).
extraction_event_threshold: 10
```

This is the only key Dev-Mem reads from `config.yml` right now. The file is optional — if it doesn't exist or the key is missing, the default of 10 is used. An invalid value (non-integer, zero, negative) logs a diagnostic and falls back to 10.

Token budget settings are not yet user-configurable through `config.yml`. The retrieval budget is calculated automatically from graph size (`nodeCount × 18`, clamped between 80 and 2000 tokens).

---

## What happens automatically after install

Once hooks are installed, every agent session does this without any manual steps:

**At session start** — Dev-Mem reads the local graph, scores stored knowledge nodes against the current working-tree state (which files are modified, what the session title is), selects the highest-scoring nodes within the token budget, and injects them into the agent's context. If any stored `FailedApproach` nodes match files you're about to work on, a regression warning is injected first.

**During the session** — Every tool call (file writes, shell commands) is recorded to `.dev-mem/events.jsonl`. For Claude Code and Codex, this includes both pre- and post-execution snapshots. For Cursor, post-execution only.

**At session end (Claude Code, Codex)** — A single batched LLM call extracts typed knowledge nodes from the session's event log. Extracted nodes start in `observed` state. This call happens in a detached background process and doesn't block the agent.

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

**Cursor: no reliable session-end flush.** Cursor's `cursor-agent` CLI does not reliably fire a session-end event when the headless process exits. Dev-Mem compensates with the N-event checkpoint (extraction fires every 10 completed tool calls by default), but if a session ends before reaching that threshold, knowledge from that session is not extracted until the next checkpoint or until you run `dev-mem wrap`. The `dev-mem wrap cursor-agent <args>` approach is the cleanest workaround.

**No automatic repair of corrupted local state.** If `.dev-mem/graph.sqlite` or `.dev-mem/events.jsonl` becomes corrupted (e.g. due to a crash mid-write or a full disk), Dev-Mem logs the failure and no-ops rather than attempting repair. To recover: delete the `.dev-mem/` directory and run `npx dev-mem install` again. You will lose accumulated graph state. There is no automatic backup.

**No symbol-level grounding.** Knowledge nodes are grounded to file paths and commit SHAs, not to specific functions or classes. If a referenced file changes substantially but isn't deleted, Dev-Mem won't detect that a node has gone stale. Staleness detection is currently existence-only: a node is marked stale when all its cited files are deleted, not when their contents change significantly.

**Single machine, local only.** `.dev-mem/` is gitignored by default. If you work across multiple machines or want to share knowledge graph state across a team, you would need to opt `.dev-mem/` into version control (`git add -f .dev-mem/` or remove it from `.gitignore`). There is no sync mechanism built in.



---

## How it works (brief)

Dev-Mem records deterministic events (git state, file touches, tool call logs) with zero LLM cost per event. At session end, one batched LLM call turns that event log into typed knowledge nodes with evidence pointers. At the next session start, a budget-constrained scoring pass selects the most relevant nodes from the graph (by topic similarity, freshness, confidence, and file proximity) and injects them as structured context.

The one-LLM-call-per-session design is deliberate: extraction is the only place an LLM is called. Capture, retrieval, and regression checks are all deterministic code with no API calls.

For the full design — node types, edge types, lifecycle states, evidence schema, scoring weights, retrieval budget formula, and evaluation results — see [`dev-mem-spec.md`](./dev-mem-spec.md) at the repo root.

---

## License

MIT
