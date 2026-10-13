# Changelog

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
