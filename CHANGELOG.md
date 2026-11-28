# Changelog

## 1.1.0 — 2026-11-28

### Added
- **Antigravity CLI & IDE Lifecycle Adapter (`adapters/antigravity/`)**: Added native `.agents/hooks.json` (`dev-memo` group with flat lifecycle entries `SessionStart`, `PreInvocation`, `Stop` and matcher-wrapped tool entries `PreToolUse`, `PostToolUse`) and `.agents/hooks/dev-mem-*.js` hook scripts. Normalizes Antigravity camelCase payloads (`conversationId`, `workspacePaths`, `toolCall`, `toolOutput`, `exitCode`), runs prompt-time delta injection on `PreInvocation`, performs mutation regression checks on `PreToolUse` / `PostToolUse` (emitting `{"decision":"allow"}` + optional `additionalContext` and failing open on internal errors), and spawns detached extraction on `Stop`.
- **CLI, MCP & Diagnostics Support (`cli/commands/install.ts`, `cli/commands/init.ts`, `cli/commands/diagnostics.ts`)**: Added `antigravity` (and `agy` alias) support to `dev-memo init` (auto-inferred when `agy` is on `PATH` and no agent directories exist), `dev-memo install` (auto-detected when `.agents/` or `GEMINI.md` exists), `dev-memo uninstall`, `findStaleHooks()`, `dev-memo doctor`, and `.agents/mcp_config.json` MCP registration.
- **`GEMINI.md` & `.agents/rules/*.md` Bootstrap Mining (`core/bootstrap/index.ts`)**: `dev-memo bootstrap` now mines `GEMINI.md` and `.agents/rules/*.md` into starter `Constraint` and `Convention` nodes at `$0` LLM cost.

### Changed
- **Host CLI Backend Replacement (`core/llm/cli-agent.ts`, `core/llm/index.ts`)**: Replaced the deprecated `gemini` CLI (`cli-gemini`) backend with **Antigravity CLI (`agy` / `cli-agy`)** across `PATH` detection (`where.exe` on Windows / `which` on POSIX), headless command construction (`agy -p ...` with prompt via `stdin`), and session-agent mapping (`antigravity` / `agy`). Explicit `cli-gemini` configs continue to route to `cli-agy` for backwards compatibility, while direct `GEMINI_API_KEY` / `GOOGLE_API_KEY` REST fallback (`core/llm/gemini.ts`) remains unchanged.

## 1.0.0 — 2026-11-28

### Added
- **Local ROI Telemetry & `dev-memo stats` (`core/telemetry/index.ts`, `cli/commands/diagnostics.ts`)**: Appends best-effort local usage metrics (`.dev-mem/telemetry.jsonl`) during session node injections and prevented regression warnings, and aggregates live metrics across SQLite nodes/edges, session dedup caches, and extraction logs (`--json` supported).
- **Zero-Server Static HTML Graph Explorer (`core/view/index.ts`, `dev-memo view`)**: Generates a standalone, zero-CDN interactive graph explorer at `.dev-mem/report.html` (SVG graph visualization, search, type/state filters, and safely escaped JSON evidence inspector), with optional `--out <path>` and `--open`.

### Changed
- **V1.0 Documentation Overhaul**: Rewrote [README.md](file:///e:/Projects/Dev-Mem/README.md) with outcome-first quick start covering all 23 CLI commands, worktree sharing, PR automation, telemetry, and offline HTML exploration, and finalized [Dev-Mem-Technical-Report.md](file:///e:/Projects/Dev-Mem/docs/Dev-Mem-Technical-Report.md) for `1.0.0`.

## 0.9.0 — 2026-11-28

### Added
- **Worktree-Shared Storage (`core/local-data.ts`)**: `resolveStorageRoot()` detects linked Git worktrees via `git rev-parse --git-common-dir` and points all `.dev-mem/` artifacts (`graph.sqlite`, `events.jsonl`, extraction locks/retries, session dedup/warnings, `config.yml`, `shared.jsonl`, `MEMORY.md`) to the main repository root so parallel worktree agents share one WAL database automatically (`DEV_MEM_ISOLATE_WORKTREE=1` opts out). Surfacing added in `dev-memo status` via `isLinkedWorktree()`.
- **Cross-Session "Live Inbox" Priority Boost (`core/retrieval/index.ts`)**: Added `currentSessionId` and `liveInboxWindowMinutes` (`120` default) to `RetrievalContext`; recent discoveries captured by sibling sessions/worktrees receive a `1.15×` relevance-gated boost (`isSiblingDiscovery: true`). Wired `currentSessionId: payload.session_id` across all four agent hooks.
- **GitHub PR Context & Auto-Verification (`core/ci/pr-context.ts`, `dev-memo pr-context`, `.github/actions/pr-context/action.yml`)**: Pure offline PR analyzer that imports `.dev-mem/shared.jsonl` on clean CI runners, renders an idempotent `<!-- dev-mem-pr-context -->` Markdown comment with regression warnings and relevant constraints/decisions, supports `--verify-on-merge` to transition matching non-failure nodes to `verified`, and includes a composite GitHub Action.

## 0.8.0 — 2026-11-28

### Added
- **SQLite FTS5 + BM25 Index (`core/graph/schema.ts`, `core/graph/index.ts`)**: Added `nodes_fts` virtual table (`tokenize = 'porter unicode61'`), delete trigger `nodes_fts_ad`, automatic startup backfill for existing SQLite stores, camelCase identifier expansion, and `GraphStore.searchFts()` weighting title (`3.0`), symbols (`2.5`), files (`2.0`), and content (`1.5`).
- **Per-Session Regression Warning Deduplication (`core/retrieval/session-dedup.ts`)**: Added `filterUnseenWarnings()` persisting surfaced `FailedApproach` node IDs to `.dev-mem/sessions/<session-id>.warnings.json` and wired it across all four adapters (`claude-code`, `codex`, `cursor`, `opencode`).
- **Multi-Repo Retrieval & Regression Benchmark (`eval/multi-repo-eval.ts`)**: Added deterministic 24-session benchmark across 3 repo corpora (`dev-mem-cli`, `ts-saas-api`, `fullstack-monorepo`) + `npm run eval:bm25` script (`95.2%` Hit@1 vs `90.5%` baseline, `0.952` MRR, `0.0%` negative leakage, `100.0%` hub-file warning suppression).

### Changed
- **Hybrid BM25 + Symbol/Directory Retrieval (`core/retrieval/index.ts`, `cli/commands/manage.ts`)**: Combined `searchFts` BM25 scoring with calibrated Jaccard topical gating (`>= 0.07`), symbol match boosts (`+0.25`), and parent-directory proximity credit (`0.4 × overlap`), plus FTS5-ranked `dev-memo search`.
- **Topical Similarity Gate in Regression Intelligence (`core/regression/index.ts`)**: Added optional `currentTask` and `minTopicOverlap` (`0.04`) filtering so partial file overlaps on shared hub files (e.g., `src/index.ts`) are suppressed when the edit is topically unrelated.

## 0.7.0 — 2026-11-28

### Added
- **Human Curation CLI (`list`, `search`, `approve`, `edit`, `forget`, `review`)**: Full terminal workflow for managing local knowledge (`cli/commands/manage.ts`, `cli/commands/review.ts`). Supports `--state`, `--type`, `--limit` filtering, content sanitization on edits, interactive `[a]pprove / [e]dit / [s]kip / [d]iscard / [q]uit` review TUI (`dev-memo review` with non-TTY fallback), and unique short-ID prefix lookup (`GraphStore.resolveNode`) across `inspect`, `approve`, `edit`, and `forget`.
- **Git-Diffable Markdown Projection (`dev-memo export --md`)**: Deterministic curated summary generator (`core/sync/markdown.ts`, also exported at `dev-memo`) producing `.dev-mem/MEMORY.md` grouped by node type with configurable `--max-lines` and optional `--agents-md` bounded `<!-- dev-mem:start -->`...`<!-- dev-mem:end -->` block updates.
- **Claude Code Auto-Memory Bootstrap (`--claude-memory`)**: `dev-memo bootstrap --claude-memory` automatically discovers `~/.claude/projects/<encoded>/memory/*.md` files for the current repo.

### Changed
- **Automatic `MEMORY.md` Sync & `.gitignore` Un-ignore**: `dev-memo sync` automatically regenerates `.dev-mem/MEMORY.md`, and `ensureDevMemGitignore()` adds `!.dev-mem/MEMORY.md` alongside `!.dev-mem/shared.jsonl` so PR reviewers can read curated team memory in plain Markdown.
- **Lifecycle Transition**: Allowed `active → verified` transitions in `core/lifecycle/index.ts` so humans can explicitly verify auto-promoted active nodes via `dev-memo approve` or `dev-memo review`.

## 0.6.0 — 2026-11-28

### Added
- **One-Command Setup (`dev-memo init`)**: Wires lifecycle hooks, registers `dev-memo mcp` in project MCP configuration files (`.mcp.json`, `.cursor/mcp.json`, `opencode.json` / `.opencode/opencode.json`), verifies the extraction backend, and runs cold-start bootstrap in one step. Automatically infers `claude-code` or `codex` from installed host CLIs when no agent config directory exists yet. Supports `--no-mcp` and `--no-bootstrap`.
- **Zero-Cost Cold-Start Bootstrap (`dev-memo bootstrap`)**: Deterministic repository seeding (`core/bootstrap/index.ts`, also exported at `dev-memo/bootstrap`) that mines recent Git revert commits into `FailedApproach` nodes and project instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*`, `.github/copilot-instructions.md`, or `--from <path>`) into `Constraint` / `Convention` nodes with secret redaction and duplicate skipping.

### Changed
- **Modular CLI Architecture**: Split monolithic `cli/index.ts` into cohesive command modules under `cli/commands/` (`init.ts`, `install.ts`, `bootstrap.ts`, `diagnostics.ts`, `inspect.ts`, `extract.ts`).

## 0.5.0 — 2026-11-28

### Added
- **Zero-API-Key Host CLI Extraction (`core/llm/cli-agent.ts`)**: Dev-Mem now reuses your already-authenticated coding agent CLI (`claude`, `codex`, `gemini`) over headless `stdin` before falling back to ambient API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`), eliminating the separate-API-key onboarding blocker. Includes a `DEV_MEM_DISABLE_HOOKS=1` recursion guard across all four agent hooks.
- **Extraction Visibility Log (`.dev-mem/extraction.log`)**: Every extraction run records timestamp, session, provider, created node count, and error reason. Surfaced directly in `dev-memo status` and `dev-memo doctor`.
- **`GraphStore.updateNode()`**: Persists title, content, evidence, and explicit timestamp updates safely in SQLite.

### Fixed
- **Prompt-Time Relevance Gate (`UserPromptSubmit` / `chat.message`)**: Gated prompt injection on raw topical `relevance >= 0.08` rather than composite score (`> 0.35`), stopping zero-relevance recent nodes from leaking into unrelated prompts when `currentFiles` is omitted.
- **Type-Aware Freshness Decay**: Replaced flat 7-day decay with type-specific half-lives (`Constraint`/`Convention`: 365d, `Decision`: 90d, `FailedApproach`: 60d, `Discovery`/`OpenIssue`: 14d).
- **Evidence Grounding & Honest Lifecycle Promotion**: Replaced synthetic `README.md`/`0000...` fallback grounding with explicit `evidence.grounded = false` tagging (excluded from file staleness and regression warnings). Auto-promotion (`observed → active`) now requires corroborating evidence (passing tests or commit advancement) and never auto-promotes `FailedApproach` or `OpenIssue` nodes.
- **Bidirectional Team Sync Tombstones & LWW**: `dev-memo sync` now exports `superseded` and curated `stale` tombstones alongside `active`/`verified` nodes and applies `updated_at` last-writer-wins updates on import so retired decisions and content edits propagate cleanly across teammates.
- **MCP Server Version**: `dev-memo mcp` `initialize` now reads `serverInfo.version` dynamically from `package.json`.

## 0.4.0 — 2026-10-17

### Added
- **Zero-Daemon Stdio MCP Server (`dev-memo mcp`)**: Exposes Dev-Mem knowledge store to any MCP-compliant client (Claude Desktop, Claude Code, Cursor, OpenCode, Codex) over stdio with zero persistent background daemons and zero open network ports. Exposes four tools:
  - `dev_mem_query`: Budget-constrained semantic and lexical retrieval of decisions, failed approaches, constraints, conventions, discoveries, and open issues.
  - `dev_mem_check_regression`: Pre-flight failure guard detecting file overlap with known failed approaches.
  - `dev_mem_remember`: Zero-LLM direct recording of verified engineering knowledge directly into the SQLite graph.
  - `dev_mem_resolve`: Explicit lifecycle state transitions (`superseded`, `stale`, `active`, `verified`).
- **Prompt-Time Context Injection (`UserPromptSubmit` & `chat.message`)**: Deterministic context injection on each prompt submission in Claude Code (`UserPromptSubmit`) and OpenCode (`chat.message`), featuring atomic per-session node deduplication (`.dev-mem/sessions/<session-id>.injected.json`) to prevent repeating context across turns.
- **Git-Friendly Team Memory Sync (`dev-memo sync`)**: Bidirectional synchronization between local `graph.sqlite` and the committed `.dev-mem/shared.jsonl` file. Only confirmed (`active` or `verified`) knowledge is exported, preserving privacy for scratch observations while allowing team-wide sharing of architectural decisions and conventions via Git. Includes automatic import on `SessionStart`.
- **Pre-Extraction Event Compactor & `dev-memo prune`**: Deterministic reduction of raw event logs prior to extraction (stripping duplicate file reads, collapsing status checks, capping test outputs) achieving 70–90% token reduction. The new `dev-memo prune` command removes events from already-extracted sessions, and runs automatically post-extraction.
- **Secret Scrubber & Privacy Tag Redaction**: Synchronous in-memory redaction before writing events or graph entries to disk. Automatically redacts high-entropy API keys (Anthropic, OpenAI, Gemini, GitHub, AWS, Slack, Bearer tokens, `.env` assignments) as `[REDACTED_SECRET]` and text enclosed in `<private>...</private>` tags as `[REDACTED_PRIVATE]`.
- **Morphological English Word Stemming**: Integrated Porter-style morphological stemming (`stemToken()`) for query and title token matching (e.g. matching `queries` to `query`, `configured` to `configure`).
- **Symbol-Aware Staleness Detection**: Validates whether referenced functions, classes, and variables (`node.evidence.symbols`) still exist in cited files, marking nodes `stale` if symbols are missing after code refactoring.
- **`supersedes` Edge Extraction & Auto-Promotion**: LLM extraction automatically detects superseded nodes and emits `supersedes` edges. Surviving `observed` nodes whose cited files remain valid are automatically promoted to `active` lifecycle state upon subsequent session completions.

### Changed
- Retrieval filtering now strictly excludes `stale` and `superseded` nodes from default context injection.
- Applied lifecycle multiplier scoring weights (`verified: 1.2`, `active: 1.0`, `observed: 0.8`, `stale: 0.0`, `superseded: 0.0`).
- `.dev-mem/.gitignore` now explicitly un-ignores `!.dev-mem/shared.jsonl` for seamless team version control.

## 0.3.0 — 2026-10-13

### ⚠ Upgrade note
Hook scripts changed format. After upgrading, run `dev-memo install` once in each project.
`dev-memo status` warns you if old hooks are still present. Upgraded hooks contain no
machine-specific paths and are safe to commit for your whole team.

### Added
- `dev-memo doctor [--live]` health check.
- `--version` and `--help` flags.
- Automatic retry of failed extractions on the next session start.
- Stale-hook warning in `dev-memo status`.
- GitHub Actions CI.

### Fixed
- Hooks no longer embed absolute install paths, and resolve dev-memo quickly on any machine.
- A corrupt line in `events.jsonl` no longer disables capture.
- `dev-memo extract` no longer reports success when extraction failed.
- `dev-memo wrap` forwards the wrapped process's exit code on Linux and macOS.
- Default models updated to current cost-efficient tiers
  (`claude-haiku-4-5`, `gemini-3.5-flash`, `gpt-5-mini`).

## 0.2.1 — 2026-09-30
- Explicit agent selection for `dev-memo install`.

## 0.2.0

### Changed
- Rebranded CLI package to `dev-memo` to resolve npm naming collisions and provide a cleaner, global un-scoped package name.
- Renamed the CLI executable from `dev-mem` to `dev-memo`. (Local data remains safely in the `.dev-mem/` directory).

## 0.1.1

### Changed
- Updated `README.md` to properly reference the scoped `@harsh_1718/dev-mem` package name on npm.
- Refined installation instructions to prioritize global installation, ensuring all subsequent `dev-mem` CLI commands work flawlessly out of the box.

## 0.1.0

### Added
- Core extraction engine powered by multiple LLM providers (Anthropic, OpenAI, Gemini, OpenAI-compatible).
- Evidence-linked persistent graph store (`.dev-mem/graph.sqlite`).
- Cross-agent adapters mapping standard AI coding assistant lifecycles (SessionStart, ToolCall, SessionEnd) for:
  - Claude Code
  - Cursor
  - Codex
  - OpenCode
- Real-time Regression Intelligence intercepting agent edits when attempting known failed approaches.
- Unified CLI interface (`install`, `status`, `extract`, `query`, `inspect`, `wrap`, `uninstall`).
- End-to-end verified evaluation harness for deterministic token accounting and state-isolation benchmarking.
