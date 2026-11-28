# Dev-Mem: Product Critique, v0.5 → v1.0 Roadmap & Phase 1 Implementation Plan

**Date:** 2026-11-28  
**Baseline:** `dev-memo` v0.4.1 (`main` @ `b064ad6`)  
**Scope:** Full competitive critique + 6-phase product roadmap (`v0.5.0` → `v1.0.0`), plus detailed TDD task breakdown for **Phase 1 (`v0.5.0`: Core Correctness, Zero-API-Key Extraction & Dogfooding)**.

---

## Part 1: Master Product Roadmap (`v0.5.0` → `v1.0.0`)

### Strategic Positioning
> *"Built-in agent memory remembers what one agent learned on one laptop. Dev-Mem gives your whole team and every agent a reviewed, evidence-backed project memory that repairs itself as the code changes."*

### Hard Engineering Invariants (Unchanged Across All Phases)
- **Zero background daemons** and **zero open network ports**.
- **`better-sqlite3` remains the sole runtime npm dependency** (no vector DBs, no heavy SDKs).
- **Node engine `>=22`**, verified across Linux and Windows (`npm run build && npm run typecheck && npm test && npm run ci:check`).
- **Simultaneous documentation:** every phase updates `README.md`, `CHANGELOG.md`, and `docs/Dev-Mem-Technical-Report.md` and ships as a clean release tag.

### What We Are Building Now (Phases 1–6) vs. Deferred (Post-1.0)
- **Phase 1 (`v0.5.0`) — Core Correctness, Zero-API-Key Extraction & Dogfooding** *(Detailed in Part 2 below)*
- **Phase 2 (`v0.6.0`) — Day-One Value (`init` + `bootstrap`) & CLI Modularization:** split `cli/index.ts` into `cli/commands/*`; `dev-memo init` for zero-friction setup + MCP wiring; deterministic `$0`-cost `dev-memo bootstrap` mining git reverts (`FailedApproach`) and existing `CLAUDE.md` / `AGENTS.md` / `.cursorrules` / `MEMORY.md`.
- **Phase 3 (`v0.7.0`) — Trust, Human Review Loop & Markdown Projection:** `list`, `search`, `approve`, `edit`, `forget` with short ID prefixes; interactive `dev-memo review` TUI (`[a]pprove / [e]dit / [s]kip / [d]iscard`) driving true `verified` state; `dev-memo export --md` producing concise, PR-reviewable `.dev-mem/MEMORY.md` (~50 lines/scope) + optional `AGENTS.md` section.
- **Phase 4 (`v0.8.0`) — FTS5/BM25 Retrieval, Noise-Free Regression Guard & Credible Eval:** SQLite FTS5 + BM25 index (`nodes_fts` kept in sync via triggers, zero new deps) + symbol/directory weighting; topical similarity gate on regression warnings + per-session dedup; 20+ real non-mock sessions evaluated across 3 real OSS repos.
- **Phase 5 (`v0.9.0`) — Worktree-Shared Memory & GitHub PR Bot:** resolve `git rev-parse --git-common-dir` so parallel worktree agents share one WAL SQLite graph; cross-session "live inbox" priority boost for recent sibling discoveries; `dev-memo/pr-context` GitHub Action commenting relevant memory on PRs and marking nodes `verified` on green merge.
- **Phase 6 (`v1.0.0`) — Visible ROI, Static Graph Viewer & Launch:** `dev-memo stats` local telemetry (injections, prevented regressions, verifications); zero-server static HTML explorer (`dev-memo view` → `.dev-mem/report.html`); outcome-first README & 1.0 launch.
- **Deferred (Post-1.0):** extra IDE-specific hooks beyond MCP (Windsurf, Cline, Copilot CLI), user-global `~/.dev-mem` & monorepo package scopes, VS Code side panel, opt-in local embeddings (only if BM25 leaves a measured gap).

---

## Part 2: Phase 1 (`v0.5.0`) Detailed Implementation Plan

**Phase 1 Goal:** Fix all critical/high correctness bugs in retrieval, evidence grounding, lifecycle promotion, and team sync; surface extraction diagnostics; eliminate the separate API key blocker via host-agent CLI extraction; and start dogfooding Dev-Mem on Dev-Mem itself.

---

### Task 1: Fix Prompt Relevance Gate & Type-Aware Freshness Decay
**Files:**
- Modify: `core/retrieval/index.ts`, `core/retrieval/retrieval.test.ts`
- Modify: `adapters/claude-code/hook.ts`, `adapters/opencode/hook.ts`, `tests/` or adapter tests

**Bugs Fixed:**
1. `UserPromptSubmit` currently gates on composite `score > 0.35`, where `proximity = 0.5` (no `currentFiles`), `freshness ≈ 1.0`, `confidence = 0.9` yields `0.53` even at `relevance = 0`. Zero-relevance nodes leak into every first prompt.
2. Freshness uses a flat 7-day half-life for all node types, causing durable `Constraint` and `Convention` rules to decay to ~0 after 90 days.

**Design:**
1. Add `relevance: number` to `RetrievedNode` interface in `core/retrieval/index.ts` and attach raw `relevance` in `retrieveContext`.
2. Add optional `minRelevance?: number` to `RetrievalContext`. When provided, filter out candidates with `relevance < minRelevance` *before* budget selection.
3. Replace flat 7-day half-life with `calculateFreshness(timestamp, type)`:
   - `Constraint` / `Convention`: 365-day half-life (near-flat for stable rules; retired via staleness/supersession instead of clock decay)
   - `Decision`: 90-day half-life
   - `FailedApproach`: 60-day half-life
   - `Discovery` / `OpenIssue` (default): 14-day half-life
4. Skip ungrounded nodes (`evidence.grounded === false`) from high-confidence boosts or penalize slightly (`0.85` multiplier) so grounded facts win ties.
5. In `adapters/claude-code/hook.ts` (`UserPromptSubmit`), pass `minRelevance: 0.15` to `retrieveContext` and remove the broken `n.score > 0.35` filter.
6. In `adapters/opencode/hook.ts` (`chat.message`), keep `SessionStart`-style retrieval on first turn (`!hasSessionState`) or apply `minRelevance: 0.15` when `currentTask` is present on subsequent turns.

**Verification:** Unit tests proving zero-relevance fresh nodes are excluded when `minRelevance: 0.15`, and 90-day-old `Constraint` outranks 90-day-old `Discovery` cleanly.

---

### Task 2: Fix Evidence Grounding, Staleness & Lifecycle Promotion
**Files:**
- Modify: `core/graph/types.ts`, `core/graph/evidence.ts`
- Modify: `core/extraction/index.ts`, `core/extraction/extraction.test.ts`
- Modify: `core/consistency/index.ts`, `core/consistency/consistency.test.ts`
- Modify: `core/regression/index.ts`

**Bugs Fixed:**
1. `core/extraction/index.ts` falls back to `commit = "0000...0"` and `files = ["README.md"]` when no session files or LLM files exist, creating fake grounding.
2. `promoteSurvivingNodes` promotes `FailedApproach` and `OpenIssue` nodes to `active` merely because a subsequent session touched one of their cited files.
3. `checkStaleness` and `checkRegressionRisk` run on fake-grounded `README.md` nodes.

**Design:**
1. Add optional `grounded?: boolean` to `Evidence` in `core/graph/types.ts` and preserve it in `normalizeEvidence` / `validateEvidence` (`core/graph/evidence.ts`).
2. In `core/extraction/index.ts`:
   - Track `hasRealCommit = Boolean(headCommit)` and `hasSessionFiles = touchedFilesSet.size > 0`.
   - When inserting a node: if `rawFiles.length > 0`, node is grounded iff at least one file exists on disk or was in `touchedFilesSet`. If `rawFiles.length === 0` and `!hasSessionFiles`, fallback to `["(ungrounded)"]` or `fallbackFiles` **and set `evidence.grounded = false`** (with `commit` set to `"0000..."` only when `!hasRealCommit`, also flagging `grounded: false` if `!hasRealCommit && !hasSessionFiles`).
3. In `core/consistency/index.ts`:
   - In `checkStaleness`: skip nodes where `node.evidence.grounded === false` (don't falsely mark abstract repo-wide conventions stale, and don't confuse them with real code-grounded nodes).
   - In `promoteSurvivingNodes`: accept `sessionHadPassingTests?: boolean` and `sessionHadNewCommit?: boolean`.
     - **Never** auto-promote `FailedApproach` or `OpenIssue` (`if (node.type === "FailedApproach" || node.type === "OpenIssue") continue;`).
     - Only promote `observed → active` when cited files are touched AND (`sessionHadPassingTests || sessionHadNewCommit`). Keep backward-compatible optional boolean params (defaulting to checking evidence when supplied by extraction).
4. In `core/extraction/index.ts`: compute `sessionHadPassingTests` (any `tool_call` in `sessionEvents` with `exit_code === 0` whose command looks like a test runner: `vitest`, `jest`, `pytest`, `cargo test`, `go test`, `npm test`, `pnpm test`, `bun test`) and `sessionHadNewCommit` (multiple distinct commits across git snapshots or commit different from pre-existing node commit), and pass them to `promoteSurvivingNodes`.
5. In `core/regression/index.ts`: skip `FailedApproach` nodes where `evidence.grounded === false`.

**Verification:** Tests verifying ungrounded nodes get `grounded: false`, `FailedApproach`/`OpenIssue` never auto-promote to `active`, and `Decision`/`Convention` promote only with passing tests or commit progress.

---

### Task 3: Bidirectional Team Sync with Tombstones & Last-Writer-Wins (`core/sync` + `GraphStore.updateNode`)
**Files:**
- Modify: `core/graph/index.ts`, `core/graph/graph.test.ts` (or existing tests)
- Modify: `core/sync/index.ts`, `core/sync/sync.test.ts`

**Bug Fixed:**
Team sync drops `superseded`/`stale` nodes from `shared.jsonl` on export and never updates already-present nodes (content edits or retirements) on import.

**Design:**
1. Add `GraphStore.updateNode(id: string, patch: { title?: string; content?: string; evidence?: Evidence; updated_at?: string }): KnowledgeNode` to `core/graph/index.ts`.
   - Also allow optional `created_at?: string` and `updated_at?: string` in `CreateNodeInput` (defaulting to `nowIso()`) so imported synced nodes preserve authoritative timestamps instead of overwriting with local import time.
2. In `core/sync/index.ts`:
   - Export curated shareable nodes: `active`, `verified`, **and** retired tombstones (`superseded`, `stale` — excluding ephemeral local `observed` scratch nodes that were never shared). Actually, any `superseded` or `stale` node that has ever been promoted or has a `supersedes`/`resolves` edge (or simply export `active`, `verified`, `superseded`, `stale` — local-only `observed` noise remains excluded!).
   - On `importSharedGraph`:
     - If node doesn't exist locally: create it preserving `created_at` and `updated_at` and `lifecycle_state`.
     - If node exists locally: compare `Date.parse(rec.node.updated_at)` vs `Date.parse(existing.updated_at)`.
       - If incoming is strictly newer (`>`), update `title`, `content`, `evidence`, `updated_at` via `store.updateNode`, and if lifecycle states differ, apply valid transition (note: `assertTransition` already allows `active → superseded/stale`, `verified → superseded/stale`, `observed → active/verified/superseded/stale`; if transitioning `superseded → ...` isn't valid, leave `superseded` monotonic since `superseded` is terminal!).
       - Keep existing `observed → active/verified` promotion even on timestamp tie.

**Verification:** Round-trip tests across two temp repos (`devA`, `devB`): Alice edits content and supersedes a Decision → `exportSharedGraph(devA)` → copy `shared.jsonl` → `importSharedGraph(devB)` → Bob's SQLite store reflects the new content and `superseded` state.

---

### Task 4: Extraction Visibility (`extraction.log`), `status`/`doctor` Reporting & MCP Metadata Fix
**Files:**
- Modify: `core/local-data.ts`
- Modify: `core/extraction/index.ts`
- Modify: `core/mcp/server.ts`, `core/mcp/server.test.ts`
- Modify: `cli/index.ts`, `cli/cli.test.ts`

**Bugs Fixed:**
- Detached `extract` runs with `stdio: "ignore"`, making LLM/parse/lock failures invisible.
- `core/mcp/server.ts` hardcodes `version: "0.4.0"`.

**Design:**
1. Add `getExtractionLogPath(projectRoot)` in `core/local-data.ts` (`.dev-mem/extraction.log`).
2. Write a compact single-line JSON log entry at the end of `runExtraction` (success or error): `{ timestamp, session_id, provider, success, nodes_created, error? }` (append-only, capped/trimmed cleanly or concise lines).
3. Update `runStatus(cwd)` and `runDoctor(cwd)` in `cli/index.ts` to read the last line of `.dev-mem/extraction.log` and show `Last extraction: <timestamp> (<status>, <provider>, <nodes> nodes)` (or warn in `doctor` if last extraction failed!).
4. In `core/mcp/server.ts`, read package version dynamically from `package.json` (matching `cli/index.ts`'s `readPackageVersion` helper) so `serverInfo.version` is never stale.

**Verification:** Tests verifying `.dev-mem/extraction.log` records both failed and succeeded extractions, `status` displays last extraction status, and MCP `initialize` reports live `package.json` version.

---

### Task 5: Zero-API-Key Extraction via Host Agent CLI (`core/llm/cli-agent.ts`) & Hook Loop Guard
**Files:**
- Create: `core/llm/cli-agent.ts`, `core/llm/cli-agent.test.ts`
- Modify: `core/llm/index.ts`, `core/llm/types.ts`, `core/llm/llm.test.ts`
- Modify: `core/extraction/index.ts` (pass `agent` hint to `resolveProviderForProject`)
- Modify: `adapters/claude-code/hook.ts`, `adapters/codex/hook.ts`, `adapters/cursor/hook.ts`, `adapters/opencode/hook.ts`
- Modify: `cli/index.ts` (improve `doctor` output for host-CLI providers and check `DEV_MEM_DISABLE_HOOKS`)

**Design:**
1. **Recursion Guard in All Hooks:** At the very top of `main()` / startup in all 4 adapter hooks (`claude-code`, `codex`, `cursor`, `opencode`), add:
   ```ts
   if (process.env.DEV_MEM_DISABLE_HOOKS === "1") process.exit(0);
   ```
2. **Create `core/llm/cli-agent.ts`:**
   - Supported CLI backends: `"claude"`, `"codex"`, `"gemini"`.
   - `isCliAvailable(bin: string): boolean` (cached/fast check using `where` on Windows / `which` on POSIX or `spawnSync(bin, ["--version"])` with short timeout — injectable runner for unit tests!).
   - `createCliAgentProvider(kind: "claude" | "codex" | "gemini", options?: { model?: string; execFn?: ... }): LlmProvider`
     - Command invocation (pipes `system + "\n\n" + prompt` via `stdin` so Windows `cmd.exe`/arg length limits are never hit!):
       - `claude`: `["-p", "--model", model || "haiku", "--output-format", "text", "--no-session-persistence", "--tools", ""]`
       - `codex`: `["exec", "-"]` (reads prompt from stdin cleanly; if `model` provided, add `["-m", model]`)
       - `gemini`: `["-p", "Read stdin and respond strictly as instructed.", ...]` or stdin prompt (with `-m` if specified)
     - Runs async `spawn` with:
       - `cwd: os.tmpdir()` (prevents host CLI from picking up project `.claude/hooks` or writing project files)
       - `env: { ...process.env, DEV_MEM_DISABLE_HOOKS: "1" }`
       - Timeout: `60_000` ms with clean kill + descriptive error on non-zero exit / empty output.
       - Note on Windows `.cmd` shims (`npm`-installed `claude.cmd`/`codex.cmd`/`gemini.cmd`): use `shell: process.platform === "win32"` ONLY on binary lookup or resolve executable path cleanly without arg splitting issues since prompt passes via `stdin`! Even better: on Windows resolve `.cmd` or use `spawn(cmd, args, { shell: process.platform === "win32" })` with fixed constant args (no user-controlled prompt in `args`!).
3. **Update `core/llm/index.ts`:**
   - Add `sessionAgent?: string` (and `probeLocal?: boolean`) to `ProviderResolutionOptions`.
   - Priority order in `resolveProvider`:
     1. Explicit override (`provider` / `DEV_MEM_LLM_PROVIDER`, or `baseUrl` / `DEV_MEM_LLM_BASE_URL`, or explicit `apiKey` / `DEV_MEM_LLM_API_KEY`): supports `"cli-claude" | "cli-codex" | "cli-gemini" | "anthropic" | "openai" | "gemini" | "openai-compatible"`.
     2. Auto-detect host agent CLI matching `sessionAgent` (`"claude-code"` → `"claude"`, `"codex"` → `"codex"`, `"gemini"` → `"gemini"`) via `detectCliBinary` (disabled during test suite if `DEV_MEM_DISABLE_CLI_LLM=1` so existing API-key tests stay deterministic!).
     3. Well-known API key env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`).
     4. Any other installed host CLI (`claude`, `codex`, `gemini`) even if session agent was e.g. Cursor/OpenCode!
4. **Wire into `core/extraction/index.ts`:** Pass `sessionAgent: agent` into `resolveProviderForProject(...)`. Update mock error tests safely so unit tests mocking missing providers set `DEV_MEM_DISABLE_CLI_LLM=1` (or pass injectable `availableClis: []`).

**Verification:**
- Unit tests for `cli-agent.ts` using mocked child spawner: verifies `DEV_MEM_DISABLE_HOOKS=1` in env, `cwd === os.tmpdir()`, prompt piped on `stdin`, JSON extracted cleanly, timeouts/non-zero exits throw cleanly.
- Integration test for `resolveProvider` priority order & `DEV_MEM_DISABLE_CLI_LLM=1` override.
- Verify in existing `cli.test.ts` and `extraction.test.ts` that no live CLI hangs tests.

---

### Task 6: Documentation Sync, Dogfooding Activation & Release `0.5.0`
**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/Dev-Mem-Technical-Report.md`
- Modify: `package.json`, `package-lock.json`

**Actions:**
1. Update `README.md` with clear, jargon-free intro + Zero-API-Key extraction instructions (host subscription CLI first, API keys optional).
2. Update `CHANGELOG.md` and `docs/Dev-Mem-Technical-Report.md` with all v0.5.0 fixes and `cli-agent` provider architecture.
3. Bump version to `0.5.0`, run `npm run build && npm run typecheck && npm test && npm run ci:check`.
4. Dogfood on `e:\Projects\Dev-Mem`: check `dev-memo install`, `dev-memo doctor`, and verify real extraction/sync on this repo.
