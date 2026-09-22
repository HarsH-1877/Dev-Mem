# Dev-Mem — Project Specification

**Status:** v1.4 — **V2 feature-complete (cross-agent handoff).** V1 exit criterion met 2026-09-18; V2 exit criterion met 2026-09-21; see `eval/results/eval-cross-agent-2026-09-21T16-44-00-031Z.md`. See §0 for change process.
**Audience:** Coding agents and contributors building this project
**Purpose:** This document is the source of truth for what Dev-Mem is, why it exists, what it must and must not do, and how it is built across versions. Any implementation decision that conflicts with this document should be flagged, not silently overridden.

---

## 0. Document Status & Change Process

This spec is written to unblock starting the project, not to lock in every detail permanently. Two things follow from that:

1. **This document will be revised as milestones complete.** Sections describing structure (§15 repo layout), scope (§13 versioning), and stack choices (§14) are expected to grow and change as real implementation surfaces things the initial draft couldn't anticipate. When a milestone reveals that a section is wrong or incomplete, update the doc — don't just quietly diverge from it in code while the doc goes stale.
2. **Not every choice below is equally well-supported.** Some decisions here are based on real technical grounding; others are reasonable defaults that haven't been rigorously validated yet. §14a marks the difference explicitly so nobody mistakes a placeholder default for a settled decision.

**Rule for agents working from this doc:** if you're about to make a structural change (new top-level folder, a materially different approach than what's written here), flag it back to the user before proceeding rather than silently reorganizing. Additive, small changes within an existing milestone's scope don't need sign-off — significant deviations do.

---



## 1. Problem Statement

AI coding agents (Claude Code, Codex, Cursor, Gemini CLI, etc.) lose all higher-level development knowledge between sessions and between tools. Git and the filesystem preserve *what the code currently is*. They do not preserve:

- Why an architectural decision was made
- What approaches were already tried and failed, and why
- Important assumptions and constraints
- Discoveries about the codebase (e.g. "session validation lives in `src/auth/session.ts`")
- Unresolved problems
- Project direction and design intent
- Conventions established during development
- What a previous agent already investigated
- What should or should not be attempted again

The result: every new session (and every switch between agents) re-discovers the same things, re-attempts previously failed approaches, and burns tokens and time re-deriving context a prior agent already had.

## 2. Product Promise

> **We reduce redundant discovery and preserve development knowledge that Git/filesystems don't encode.**

Reframed precisely: Dev-Mem does not provide "shared memory between agents." It provides **shared, verified development state across agents** — a structured, evidence-backed, lifecycle-aware record of what has been learned while building the software, made available to whichever agent is working next, in exactly the quantity it can use.

## 3. What We Are Building (Distribution & Packaging Model)

Dev-Mem is an **npm CLI package with an internal core library and per-agent adapters** — local-first, no server, no hosted service. This is a firm decision, not an open question; implementation should not introduce a server, a hosted backend, or a GUI/desktop app.

### 3.1 Three Layers


| Layer            | What it is                                                                                                                                                                                                      | Lives in    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Core library** | Plain TypeScript modules: graph store, capture, extraction, retrieval, lifecycle. No CLI logic, no assumptions about how it's invoked. Fully importable and unit-testable on its own.                           | `core/`     |
| **CLI**          | The distribution and setup mechanism. `npx dev-mem install` wires the core into an agent's hook system and creates the local data store in the current project.                                                 | `cli/`      |
| **Adapters**     | Thin, per-agent glue modules that translate an agent's native hook/event system into calls against the core library. Claude Code first (V1), Codex and Cursor added in V2 with no changes required to the core. | `adapters/` |


This mirrors how comparable tools in this space distribute (e.g. `npx claude-mem install`, `bd init`) — it is the only model that reaches a working agent's hook system without requiring a server.

### 3.2 Why Not the Alternatives

- **Not a pure library with no CLI** — a developer needs a one-command way to wire hooks into their repo; nobody hand-writes hook configuration.
- **Not a hosted/cloud service** — directly contradicts the local-first constraint (§4.4) and the token/privacy-conscious framing of this project. All data stays in the user's own repo.
- **Not a GUI or desktop app** — the integration points (Claude Code hooks, Codex, Cursor) are all CLI/terminal-native, so a CLI-first tool is the natural fit.



### 3.3 Runtime & Package Details

- **Language/runtime:** TypeScript, running on Node.js. This has a concrete technical justification, not just convention: Claude Code hooks communicate via JSON over stdin/stdout through a shell command, so they are language-agnostic by design — but Node.js is specifically documented as the safer cross-platform default because Claude Code guarantees Node's availability on every platform, whereas a Python-based hook only works reliably if Python is installed everywhere the tool runs.
- **Package name:** `dev-mem` (npm). Binary name: `dev-mem`.
- **License:** MIT (matches ecosystem norms for this category — keeps the tool easy to embed in other developer tooling).
- **Local data location:** a `.dev-mem/` directory created at the root of the user's project (sibling to `.claude/`), containing:
  - `.dev-mem/graph.sqlite` — the knowledge graph store (§5) — see §14a for confidence level on this choice
  - `.dev-mem/config.yml` — user-configurable settings. Currently only `extraction_event_threshold` (positive integer, default 10) is read; this controls how often Cursor triggers extraction in the absence of a reliable SessionEnd event. Token budget and enabled-adapters settings are described in §8 and §12 but are not yet configurable through this file.
  - `.dev-mem/` should be gitignored by default, with an explicit opt-in flag if a team wants to commit and share it.



### 3.4 CLI Commands (V1 minimum surface)


| Command                     | Purpose                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `dev-mem install`           | Detects the current project's agent(s), wires hooks, creates `.dev-mem/`                                                                   |
| `dev-mem status`            | Shows graph size, last capture time, lifecycle state breakdown                                                                             |
| `dev-mem query "<text>"`    | Runs retrieval for a given task description and prints the §9-format context a session would receive; uses the same adaptive budget and relevance scoring as the live SessionStart hook |
| `dev-mem inspect <node-id>` | Prints a single node's full fields, evidence, lifecycle history, and edges                                                                                                            |
| `dev-mem uninstall`         | Removes hooks from all detected agent configs; leaves `.dev-mem/` data intact unless `--purge` is passed                                   |
| `dev-mem wrap <cmd> [args]` | Runs a command and flushes any remaining captured events through extraction on exit; primarily useful for Cursor (missing reliable SessionEnd) |
| `dev-mem extract <session>` | Manually triggers extraction for a session ID; normally invoked automatically by hooks; skips silently if already complete for that session |




## 4. Non-Negotiable Design Constraints

These constraints override any individual feature idea. If a feature conflicts with one of these, the feature is wrong, not the constraint. (Note: these are product/behavioral constraints, not implementation details — unlike §14a, these are not up for revision as the project evolves.)

1. **Net token-neutral or token-positive.** Dev-Mem must never increase a user's net token spend. Capture must be near-zero-cost (deterministic, not LLM-per-event). Retrieval must be budget-constrained and never exceed a configured cap. Success is measured as *tokens spent on memory operations* vs. *tokens saved by avoided rediscovery* — the latter must exceed the former.
2. **No hallucination amplification.** Injected context must be structured, evidence-linked, and confidence-labeled — never an unlabeled prose blob the receiving agent might treat as equally certain fact. When in doubt, omit a low-confidence item rather than inject it.
3. **Deterministic capture first, LLM second.** Anything that can be captured from git/filesystem/tool-call events without an LLM call must be. LLM calls are reserved for batched knowledge *extraction*, not raw event logging.
4. **Local-first, no server.** All data lives in the user's own repo (`.dev-mem/`). No hosted backend, no telemetry, no external service dependency for core functionality.
5. **Evidence is mandatory, symbol-level grounding is not (yet).** Every knowledge item must cite at least a commit/diff/file. Tree-sitter/AST symbol-level grounding is explicitly deferred — see §10, Non-Goals for V1.
6. **Provider-neutral.** Claude Code, Codex, and Cursor (in that build order) are first-class, not "Claude Code plus adapters bolted on later."



## 5. Core Abstraction: Development State, Not "Memory"

"Memory" implies a passive store. Dev-Mem's core abstraction is **Development State**: a typed, evidence-backed graph with an explicit lifecycle, where every node represents a claim about the project that can be verified, superseded, or allowed to go stale.

### 5.1 Node Types


| Type             | Description                                               | Example                                                                   |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Decision`       | An architectural or implementation choice, with rationale | "Use Firebase Admin for server-side auth"                                 |
| `FailedApproach` | Something tried and rejected, with the reason             | "Client-side token verification caused inconsistent server session state" |
| `Constraint`     | A rule the codebase must obey                             | "Provider-specific auth logic must stay behind `AuthProvider`"            |
| `Discovery`      | A fact learned about the existing codebase                | "Session validation is centralized in `src/auth/session.ts`"              |
| `Convention`     | An established pattern/style                              | "All API routes use zod schemas for input validation"                     |
| `OpenIssue`      | Known unresolved problem                                  | "OAuth E2E tests still fail in production-like environments"              |


*(Skill/procedure nodes are explicitly out of scope for V1 — see §10.)*

### 5.2 Edge Types


| Edge              | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `supersedes`      | Node A replaces/overrides Node B                           |
| `contradicts`     | Node A and Node B cannot both be true; needs resolution    |
| `depends-on`      | Node A only makes sense given Node B                       |
| `discovered-from` | Node A was found while working on task/session B           |
| `resolves`        | Node A (e.g. a Decision) closes Node B (e.g. an OpenIssue) |




### 5.3 Knowledge Lifecycle

Every node has an explicit state, not just a timestamp:

```
observed → verified → active → superseded → stale
```

- **observed**: extracted from a session, not yet cross-checked
- **verified**: evidence (commit/diff/file) confirmed to currently exist/match
- **active**: verified and currently relevant (default resting state)
- **superseded**: an explicit newer node replaces it (`supersedes` edge present)
- **stale**: evidence no longer resolves (file/commit gone or materially changed) and no superseding node exists yet — surfaced for review, not silently dropped



### 5.4 Evidence Schema (mandatory fields)

```yaml
evidence:
  commit: <sha>              # required
  files: [<path>, ...]       # required, at least one
  diff_ref: <sha range>      # optional but recommended
  test_ref: <test name/path> # optional
  symbols: [<symbol name>]   # optional in V1, populated in V2+ (see §10)
  session_id: <id>           # required — which session produced this
  agent: <claude-code|codex|cursor|...>  # required — which agent produced this
  timestamp: <iso8601>       # required
  confidence: <0.0-1.0>      # required — extraction confidence, not correctness
```



## 6. Core Loop

```
Agent activity
   → deterministic capture (git diff, file touches, commands run, test results — zero LLM cost)
   → batched LLM extraction at checkpoints (session end / N tool-calls) → typed knowledge nodes w/ evidence
   → lifecycle state assignment (observed → verified → active → superseded → stale)
   → budget-constrained ranked retrieval (relevance + freshness + confidence + graph proximity, under token cap)
   → structured, labeled, confidence-tagged context assembly
   → injected into next agent/session
   → outcome measured (redundant discovery avoided, net token delta, regression-repeat rate, success rate)
```



## 7. Capture Pipeline



### 7.1 Deterministic layer (always on, no LLM cost)

- Git: commits, diffs, branch/worktree info
- Filesystem: files touched, created, deleted
- Tool-call log: commands run, test pass/fail, exit codes
- Session boundaries: start/end, agent identity



### 7.2 Extraction layer (LLM, batched — not per-event)

- Triggered at session end (Claude Code/Codex), or after N accumulated tool-calls (Cursor), configurable via `.dev-mem/config.yml`.
- *Note on Cursor*: Cursor's CLI (`cursor-agent`) does not reliably fire a `SessionEnd` event when the headless process exits, and its hook schema uses a flat array with `camelCase` event names (unlike Claude Code/Codex's nested `PascalCase` schema). To compensate for the missing `SessionEnd`, the Cursor adapter relies on the N-accumulated-events checkpoint trigger evaluated at the end of each turn (`stop`).
- Single batched LLM pass over the session's deterministic log → proposes typed nodes with evidence pointers
- Extraction is the *only* place an LLM call is allowed in the capture path

### 7.3 Hook Failure Handling and Lifecycle Recovery

Hooks are best-effort observers and must never terminate or otherwise disrupt the host coding agent. They write diagnostic messages to stderr and exit successfully when they cannot safely act.

- **Malformed payloads:** invalid JSON, non-object input, unsupported event names, and missing/wrong-type `session_id` or `cwd` are logged and ignored. Unknown extra fields are ignored.
- **Out-of-order events:** a tool event without a recorded SessionStart is captured with its supplied session ID so a restarted hook process can retain useful evidence. A SessionEnd or Cursor checkpoint without a prior SessionStart is logged and does not trigger extraction. Repeated SessionEnd/checkpoint delivery is harmless: extraction is serialized per session and a completed session is not extracted again.
- **Cursor checkpoints:** `extraction_event_threshold` must be a positive integer; missing, unreadable, or invalid configuration logs a diagnostic and falls back to 10. A checkpoint trigger may race, but only one CLI extraction for a session may run or complete at a time.
- **Shared local state:** the SQLite graph uses WAL mode and a 5-second busy timeout so concurrent hook processes wait briefly for a writer instead of failing immediately. Node plus lifecycle-history creation is transactional. If SQLite, the event log, or the filesystem is unavailable/corrupt/full, the affected hook logs the failure and no-ops; it must not claim successful capture or extraction.

This is deliberately limited to safe failure and clear diagnostics. Dev-Mem does not attempt automatic repair of corrupted `.dev-mem/` state; users may restore it from a backup or remove it to begin a new local state store.



## 8. Retrieval: Budget-Constrained Ranking

Given a token budget `B` for injected context, and a set of candidate nodes each with:

- `relevance(node, current_task)` — semantic/task-similarity score
- `freshness(node)` — decays with age, resets on verification
- `confidence(node)` — extraction confidence × verification status
- `graph_proximity(node, files_about_to_be_touched)` — distance in the knowledge graph to the current task's files
- `cost(node)` — token cost of injecting this node

Compute a composite score:

```
score(node) = w1·relevance + w2·freshness + w3·confidence + w4·graph_proximity
```

Then select the subset of nodes maximizing total score subject to `Σ cost(node) ≤ B` — this is a **0/1 knapsack problem**, solved exactly for small candidate sets (typical case) or via a greedy/approximate solver for large ones. *(See §14a — this approach hasn't yet been validated against a real workload size; treat as the starting design, not confirmed-optimal.)*

Injection is **tiered**: default injection is compact (ID + one-line title per node); an agent (or Dev-Mem itself, if the task clearly warrants it) can expand a specific node to full detail on demand, rather than always injecting full text for every retrieved node.

### 8.1 Regression Intelligence (flagship feature)

Before/while an agent is about to attempt an approach, check the candidate action against `FailedApproach` nodes relevant to the same files/task. If a match is found above a confidence threshold, surface it proactively:

```
⚠ A similar approach was already tried and failed:
"Client-side token verification caused inconsistent server session state"
(session: sess_182, commit: a1b2c3d, confidence: 0.86)
```

This is an active check, not passive storage — it is the single most defensible, non-generic feature in the product and should be treated as the headline capability.

### 8.2 Lightweight Consistency Check (scoped down — not an audit subsystem)

Dev-Mem performs a **minimal** check limited to:

- Flagging `contradicts` relationships between two *stored* nodes (not re-verifying every claim against live repo state)
- Marking a node `stale` when its cited file/commit evidence no longer resolves cleanly (existence check only, not deep semantic re-validation)

This exists solely to satisfy the no-hallucination-amplification constraint (§4.2) — it is explicitly **not** a validation/audit product, does not attempt exhaustive fact-checking, and must not grow into one. If a future contributor is tempted to expand this into a full verification engine, that is out of scope — revisit §10.

## 9. Context Assembly Format

Injected context must be structured and labeled, never a prose paragraph. Example:

```
[DECISION] (confidence: 0.91, verified 2 days ago)
Use Firebase Admin for server-side authentication.
Evidence: commit a1b2c3d, src/auth/provider.ts

[FAILED APPROACH] (confidence: 0.86, observed 5 days ago)
Client-side token verification — caused inconsistent server session state.
Evidence: commit 9f8e7d6, src/auth/legacy_verify.ts (removed)

[CONSTRAINT] (confidence: 0.95, verified today)
Provider-specific auth logic must remain behind AuthProvider abstraction.
Evidence: src/auth/provider.ts

[OPEN ISSUE] (confidence: 0.80, observed 1 day ago)
OAuth E2E tests still fail in production-like environments.
Evidence: test_ref: e2e/oauth.spec.ts, session sess_190
```

Confidence and recency are always visible so the receiving agent can weight trust appropriately rather than treating everything as equally certain.

## 10. Explicit Non-Goals (V1, and in general)


| Not building                                                                                       | Why                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tree-sitter / AST symbol-level provenance in V1                                                    | Prove file/commit/diff-level grounding works first; add symbol grounding only if evidence shows it materially improves retrieval or staleness detection |
| Skill/procedure distillation                                                                       | Already a heavily saturated sub-category (6+ existing OSS tools); distracts from the core knowledge-graph problem                                       |
| Full validation/audit engine (re-verifying every claim against live repo state on every retrieval) | Out of scope by design decision — see §8.2. A minimal existence/contradiction check is in scope; a full audit subsystem is not                          |
| Hosted/cloud backend, multi-tenant server, SSO, billing                                            | Contradicts the local-first packaging decision in §3                                                                                                    |
| General-purpose "memory for any AI app"                                                            | Dev-Mem is coding-agent-specific and development-state-specific, not a generic memory API                                                               |




## 11. Evaluation Methodology

Every version must be benchmarked, not just demoed. Required metrics:

1. **Redundant discovery avoided** — did the agent re-investigate something already known? (primary metric; hardest to game)
2. **Regression-repeat rate** — how often does an agent re-attempt a known failed approach, with vs. without Dev-Mem?
3. **Net token delta** — (tokens spent on capture + retrieval) − (tokens saved by avoided rediscovery); must be net-positive
4. **Task success rate** — with vs. without Dev-Mem, on tasks that depend on prior context
5. **Time-to-completion** — wall-clock, with vs. without

**Test harness**: a fixed sample repo with a sequence of ~10-15 tasks where later tasks genuinely depend on knowledge from earlier ones (e.g. task 2 requires knowing a decision made in task 1). Run each sequence with Dev-Mem OFF and ON, and publish the comparison table.

**V1 scope**: V1 evaluation validates **single-agent performance only** (Claude Code sessions across time). Multi-agent comparison (measuring knowledge transfer across at least two different agents) is explicitly a **V2 requirement** — it cannot be tested until Codex/Cursor adapters exist (§12, §13).

## 12. Cross-Agent Adapter Layer

A single core service (capture + graph store + retrieval) behind a thin, provider-neutral adapter interface:

```
Adapter interface (per agent):
  onSessionStart(context) → inject assembled context
  onToolCall(event)       → forward to deterministic capture
  onSessionEnd(transcript) → trigger batched extraction
```

Build order: **Claude Code hooks first** (SessionStart, PostToolUse, Stop, SessionEnd) → prove the loop end-to-end → **Codex adapter** → **Cursor adapter**. Each adapter should require no changes to the core service — only wiring.

*(Note: at least one other project —* `difflore-cli`*, a Rust tool — uses a similar adapter-trait-per-client pattern across Claude Code, Cursor, Zed, Gemini CLI, and Windsurf. This is treated as validation that the pattern is sound, not as a reason to change approach — but worth being aware of as the competitive landscape keeps moving.)*

## 13. Versioning Plan



### V1 — Prove the Core Loop (MVP)

**Goal: does sharing development knowledge measurably reduce redundant discovery and tokens, for a single agent?**

- CLI scaffolding (`dev-mem install`/`status`/`query`/`inspect`) and `.dev-mem/` local data directory (§3)
- Deterministic capture (git/filesystem/tool events) — Claude Code only
- Batched LLM extraction at session end → typed nodes with file/commit/diff evidence (no symbol-level grounding)
- Local graph store (SQLite, graph modeled via tables + recursive CTEs)
- Basic lifecycle: `observed → active → stale` (supersede/verify logic simplified)
- Budget-constrained retrieval (relevance + freshness + confidence; graph proximity can be approximated, not full symbol-graph, in V1)
- Regression Intelligence: flag re-attempts of known failed approaches (file/commit-level matching)
- Structured, labeled, confidence-tagged context injection
- Minimal contradiction flagging between stored nodes (§8.2)
- Full eval harness (§11) run against Claude Code only, single-agent (no handoff yet) — validates the core hypothesis before investing in cross-agent work

**V1 exit criterion**: eval harness shows a measurable reduction in redundant discovery and a net-positive token delta, single-agent, before proceeding to V2.

**✅ V1 EXIT CRITERION MET — 2026-09-18**

Results from `eval/results/eval-corrected-2026-09-18T08-28-55-235Z.md` (eval using real shipped `adaptiveBudget(nodeCount)` default, no override, 12-task sequence):

- Redundant discoveries: 13 eliminated (100%)
- Regression repeat rate: 8.3% → 0.0%
- Net token delta: **+562 tokens** (OFF: 4,781 / ON: 4,219)
- Task success rate: 100% both modes
- Injection overhead: 1,501 tokens total, plateaus rather than growing unbounded (budget adapts to graph size at each session)

This result was verified against the actual shipped adaptive default, not a placeholder value.

**Budget-calibration lesson learned:** A flat token ceiling (e.g. 2000) makes relevance filtering a no-op on small graphs — if the entire graph costs fewer tokens than the budget, every node is always injected and relevance scores have no effect. The fix is an adaptive default proportional to graph size (`nodeCount × 18`, clamped 80–2000), so roughly half the graph is always subject to selection pressure regardless of how large or small the graph is. This is now the default in `core/retrieval/index.ts`. Do not revert to a flat ceiling without re-running the eval.

**V1 is feature-frozen for Claude Code.** No new Claude Code capabilities until V2 (Codex/Cursor adapters) is under way.

### V2 — Cross-Agent Handoff

**Goal: does this work across different agents, not just across sessions of the same agent?**

- Codex and Cursor adapters added behind the same core service
- Full lifecycle including `verified` and `superseded` states, with explicit `supersedes`/`contradicts` edges
- Graph-proximity retrieval signal fully implemented (real dependency graph between files, not approximation)
- Eval harness re-run in cross-agent mode (agent A works, agent B picks up) — this is where the "reduce redundant discovery across agents" claim gets actually tested
- Regression Intelligence extended across agents (an approach that failed under Codex should be flagged to Claude Code, and vice versa)

**✅ V2 EXIT CRITERION MET — 2026-09-21**

Results from `eval/results/eval-cross-agent-2026-09-21T16-44-00-031Z.md` (12-task Claude Code → Codex handoff, using the shipped adaptive retrieval budget and real content-string token counts):

- Redundant discoveries: 13 eliminated (100%)
- Regression repeat rate: 8.3% → 0.0%
- Net token delta: **+562 tokens** (OFF: 4,661 / ON: 4,099)
- Task success rate: 100% in both modes
- Cross-agent retrieval: 17 Claude Code-authored nodes were retrieved and injected into Codex sessions
- Cross-agent Regression Intelligence: Codex received a warning before re-attempting the SQLite approach previously recorded as failed by Claude Code

The result was independently recomputed from the cross-agent harness's actual task, injection, and rediscovery strings; it does not reuse V1 totals. The numerically identical +562-token delta is expected because the shared task and dependency strings yield the same injection and avoided-rediscovery terms, while the agent-specific system-prompt difference is included in both OFF and ON totals and therefore cancels from the delta.



### V3 — Symbol-Level Grounding + Refinement (conditional)

**Goal: only pursue if V1/V2 data justifies it.**

- Tree-sitter-based symbol-level provenance (start with one language: Python or JS/TS)
- Symbol-aware staleness detection (flag a node stale when its referenced function/class is renamed or removed, not just when the file changes)
- Symbol-level graph proximity for retrieval ranking
- Revisit whether team/multi-repo constraint propagation is worth adding

*(V3 should not begin until V1/V2 eval data shows file/commit-level grounding is insufficient — this is a data-driven gate, not a default next step.)*

## 14. Tech Stack


| Component             | Choice                                                                    | Notes                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Language/runtime      | TypeScript on Node.js                                                     | See §3.3 — technically justified, not just convention                                                                        |
| Package/distribution  | npm (`dev-mem`), CLI binary `dev-mem`                                     | See §3                                                                                                                       |
| Graph store           | SQLite (tables + recursive CTEs)                                          | Local file at `.dev-mem/graph.sqlite`; no server dependency — see §14a, this specific choice is a default pending comparison |
| Capture hooks         | Native Claude Code hook system                                            | SessionStart/PostToolUse/Stop/SessionEnd; JSON over stdin/stdout, language-agnostic protocol                                 |
| Extraction            | Single batched LLM call per checkpoint                                    | Structured output (JSON schema matching §5)                                                                                  |
| Retrieval scoring     | Plain TypeScript; exact knapsack for small N, greedy fallback for large N | Validated in V1 eval; adaptive budget default (nodeCount × 18, clamped 80–2000) — see §13 budget-calibration note           |
| Testing               | Vitest (or Jest)                                                          | Unit tests required for graph store, capture, retrieval scoring; the Vitest-vs-Jest pick specifically is arbitrary           |
| Adapters (V2)         | Thin per-agent modules implementing the interface in §12                  | No core-service changes required per adapter                                                                                 |
| Symbol grounding (V3) | tree-sitter                                                               | One language first                                                                                                           |
| License               | MIT                                                                       | Matches ecosystem norms                                                                                                      |




### 14a. Confidence Level Per Decision (be skeptical accordingly)


| Decision                                    | Confidence                                               | Basis                                                                                                                                                                                                                                     |
| ------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript/Node as runtime                  | **High**                                                 | Verified: hooks are JSON stdin/stdout (language-agnostic), and Node is Claude Code's documented, guaranteed-available cross-platform default — Python is not guaranteed present                                                           |
| npm CLI + core library + adapters packaging | **High**                                                 | Matches how multiple real competitor tools in this space distribute (Claude-Mem, Beads, agent-mem, difflore-cli)                                                                                                                          |
| Local-first, no server                      | **High**                                                 | Direct product requirement (token/privacy framing), not a technical guess                                                                                                                                                                 |
| SQLite + recursive CTEs for the graph store | **Medium-low — unvalidated**                             | Chosen for zero-dependency simplicity; not benchmarked against an embedded graph DB (e.g. Kùzu) for this specific access pattern (small local graphs, frequent relevance-ranked traversal). Should be validated before treating as final. |
| Knapsack-based retrieval scoring            | **Medium-high — validated in V1 eval**                   | Greedy knapsack with relevance+freshness+confidence+proximity scoring confirmed net-positive at 12-node graph. Adaptive budget default prevents the no-op failure mode. See §13.                                                          |
| Vitest over Jest                            | **Low — arbitrary**                                      | No real comparison done; either is fine, pick and move on                                                                                                                                                                                 |
| Full repo structure (§15)                   | **Starting point only**                                  | Expected to change — see §0                                                                                                                                                                                                               |




## 15. Repo Structure

**This is a starting skeleton, not a final layout — see §0.** Expect new folders (e.g. for config schemas, eval fixtures, adapter-specific test doubles) to be added as milestones progress. Flag significant structural changes back to the user; small additive changes don't need sign-off.

```
dev-mem/
  package.json
  cli/
    index.ts          # dev-mem install / status / query / inspect / uninstall
  core/
    capture/           # deterministic event capture
    extraction/         # batched LLM extraction
    graph/               # node/edge schema + store
    retrieval/           # scoring + knapsack selection
    lifecycle/            # state machine
  adapters/
    claude-code/
    codex/              # V2
    cursor/             # V2
  eval/
    harness/
    sample-repo/
    results/
  docs/
    dev-mem-spec.md      # this document
```



## 16. Glossary

- **Development State**: the core abstraction — a typed, evidence-backed, lifecycle-aware graph of claims about the project (not "memory")
- **Node**: a single typed knowledge item (Decision, FailedApproach, Constraint, Discovery, Convention, OpenIssue)
- **Evidence**: the mandatory provenance attached to every node (commit, files, session, agent, confidence)
- **Regression Intelligence**: active detection of an agent about to repeat a known failed approach
- **Net token delta**: the core success metric — tokens spent on Dev-Mem operations minus tokens saved by avoided rediscovery
- `.dev-mem/`: the local, per-project, gitignored-by-default directory holding the graph store and config

---

*End of specification. This is v1.4, updated to reflect V2 feature-complete status (cross-agent handoff, 2026-09-21). V1 and V2 exit criteria are met; see §13. V3 remains conditional on evidence that file/commit-level grounding is insufficient.*
