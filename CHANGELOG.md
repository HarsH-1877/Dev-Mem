# Changelog

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
