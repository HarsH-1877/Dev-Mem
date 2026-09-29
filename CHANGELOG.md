# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - Package Rebrand

### Changed
- Rebranded CLI package to `dev-memo` to resolve npm naming collisions and provide a cleaner, global un-scoped package name.
- Renamed the CLI executable from `dev-mem` to `dev-memo`. (Local data remains safely in the `.dev-mem/` directory).

## [0.1.1] - README & Documentation Polish

### Changed
- Updated `README.md` to properly reference the scoped `@harsh_1718/dev-mem` package name on npm.
- Refined installation instructions to prioritize global installation, ensuring all subsequent `dev-mem` CLI commands work flawlessly out of the box.

## [0.1.0] - Initial Release

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
