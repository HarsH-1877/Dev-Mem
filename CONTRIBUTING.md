# Contributing to Dev-Mem

Thank you for your interest in contributing to Dev-Mem. This document defines the rules, conventions, and process for contributing. Read it in full before opening an issue or a pull request.

## Before You Start

`dev-mem-spec.md` at the repository root is the authoritative technical specification for this project. It is a living document that defines the architecture, data model, non-negotiable constraints, and versioning plan. Any contribution that conflicts with it will not be merged without first updating the spec and getting maintainer agreement on the change. When in doubt, read the spec before opening an issue or writing code.

## Core Architectural Constraints

These are non-negotiable. A pull request that violates any of the following will be rejected regardless of code quality:

1. **Single LLM call site.** The entire codebase must contain exactly one place that makes an LLM API call: the batched extraction module. No other file, hook, or command may call an LLM, directly or indirectly. This is required to keep the tool's token cost measurable and bounded.
2. **Net token-neutral or better.** Dev-Mem must never increase a user's net token spend. Any change to capture, extraction, or retrieval must be evaluated against this constraint, not assumed to satisfy it.
3. **Deterministic capture first.** Anything that can be captured from git, the filesystem, or tool-call events without an LLM call must be implemented that way. LLM usage is reserved for extraction only.
4. **Local-first, no server.** Dev-Mem does not communicate with any hosted backend, telemetry service, or third-party server. All state lives in the user's own repository under `.dev-mem/`. Do not introduce a network dependency beyond the LLM API call made during extraction.
5. **Evidence is mandatory.** Every knowledge node written to the graph must carry a complete evidence record (commit, files, session ID, agent, timestamp, confidence) as defined in the spec. Do not relax this schema.
6. **Provider-neutral adapters.** Claude Code, Codex, and Cursor are all first-class. A change to `core/` must not assume or depend on the behavior of any single adapter. Adapter-specific logic belongs in `adapters/<agent>/`, not in `core/`.
7. **No external LLM provider SDKs.** LLM calls use the native Node.js `fetch` API directly, not `@anthropic-ai/sdk`, `openai`, or equivalent packages. This keeps the CLI's dependency footprint minimal.

## Dependency Policy

Before adding any new runtime dependency to `package.json`, open an issue describing why it is needed and what native Node.js alternative was considered and rejected. Unsolicited pull requests that introduce a new runtime dependency without a prior issue discussion will not be merged. Development-only dependencies (TypeScript, Vitest, type definitions) are generally acceptable but should still be justified in the pull request description.

## Module Boundaries

Do not introduce circular dependencies between `core/` modules. Each of `core/graph/`, `core/capture/`, `core/extraction/`, `core/retrieval/`, `core/regression/`, and `core/consistency/` must remain independently testable. If a change requires two modules to depend on each other, the design is wrong; raise it as an issue before implementing.

## Local Development Setup

### Prerequisites

- Node.js version 22 or later
- Git

### 1. Fork and Clone

```bash
git clone https://github.com/YOUR_USERNAME/Dev-Mem.git
cd Dev-Mem
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Build

```bash
npm run build
```

This compiles `core/`, `cli/`, and `adapters/` into `dist/`.

### 4. Run the CLI Locally

Run the compiled binary directly without publishing:

```bash
node dist/cli/index.js status
```

Alternatively, run `npm link` to make the `dev-mem` command resolve to your local build for manual testing inside another repository.

## Code Style

- The project is written in TypeScript targeting native ES Modules. When importing a local file, the import specifier must include the `.js` extension, matching the compiled output (for example, `import { createNode } from './graph/index.js'`), even though the source file is `.ts`.
- Do not introduce a linter or formatter configuration change in a pull request that is not primarily about tooling. Keep formatting consistent with the surrounding file.
- Do not leave unreachable or dead code behind a return statement. If a function is refactored, delete the code it replaces in the same change.

## Testing

Tests use Vitest and are co-located with the code they test (for example, `core/graph/store.test.ts` tests `core/graph/index.ts`).

Requirements for any pull request that changes behavior:

- Every new feature must include a test that verifies actual output, not merely that the code runs without throwing.
- Every bug fix must include a test that reproduces the original failure and confirms the fix.
- All existing tests must continue to pass. Do not modify or delete an existing test to make it pass unless the test itself was incorrect, and explain why in the pull request description.

Run the full suite before submitting:

```bash
npm test
```

Watch mode during development:

```bash
npm run test:watch
```

## Evaluation Changes

Any change to `core/retrieval/`, `core/regression/`, or `core/extraction/` that could plausibly affect token usage, retrieval quality, or the results reported by the evaluation harness must be verified by running `eval/harness/` before and after the change and including both results in the pull request description. Do not assert that a change improves or preserves behavior without measured evidence from the harness. Estimated or assumed token figures are not acceptable; the evaluation harness computes real counts from actual content and must not be modified to use flat multipliers or placeholder values.

## Pull Request Process

1. Create a branch: `feat/short-description` or `fix/short-description`.
2. Make your change, keeping it scoped to a single concern. Large, multi-purpose pull requests will be asked to be split.
3. Add or update tests as described above.
4. Run `npm run build` and `npm test` and confirm both succeed.
5. If the change affects `dev-mem-spec.md`'s description of current behavior (a new command, a changed config key, a changed default), update the spec in the same pull request. Do not let the spec drift from the implementation.
6. Write a clear commit history and a pull request description that states what changed, why, and how it was tested.
7. Reference any issue the pull request resolves (for example, "Fixes #12").
8. Open the pull request against `main`.

A maintainer will review for correctness, adherence to the constraints above, and test coverage before merging. Pull requests that do not follow this process may be asked to be revised before review begins.

## Reporting Issues

When opening an issue, include:

- What you expected to happen and what actually happened.
- The Dev-Mem version (`dev-mem --version` or the version in your `package.json`), Node.js version, and operating system.
- Which agent adapter is involved, if relevant (Claude Code, Codex, or Cursor).
- Steps to reproduce, including relevant contents of `.dev-mem/events.jsonl` or `dev-mem status` output if the issue involves capture, extraction, or retrieval.

## License

By contributing to Dev-Mem, you agree that your contributions will be licensed under the MIT License, matching the project's existing license.
