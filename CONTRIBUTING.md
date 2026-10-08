# Contributing to Dev-Mem

Thank you for your interest in contributing to Dev-Mem. This document defines the rules, conventions, and process for contributing.

> **These guidelines are mandatory, not advisory.** Read this document in full before opening an issue or a pull request. A pull request that does not follow it will be asked to be revised, or closed without further review. Maintainers are not obligated to review a pull request that fails the checks in [Pre-Submission Checklist](#pre-submission-checklist).

## Table of Contents

1. [Before You Start](#before-you-start)
2. [Issue-First Policy](#issue-first-policy)
3. [Core Architectural Constraints](#core-architectural-constraints)
4. [Dependency Policy](#dependency-policy)
5. [Module Boundaries](#module-boundaries)
6. [Local Development Setup](#local-development-setup)
7. [Scope and File Hygiene](#scope-and-file-hygiene)
8. [Code Style](#code-style)
9. [Testing](#testing)
10. [Evaluation Changes](#evaluation-changes)
11. [Pull Request Process](#pull-request-process)
12. [Pre-Submission Checklist](#pre-submission-checklist)
13. [Review and Merge Policy](#review-and-merge-policy)
14. [Use of AI Tools](#use-of-ai-tools)
15. [Reporting Issues](#reporting-issues)
16. [Security](#security)
17. [Code of Conduct](#code-of-conduct)
18. [License](#license)

## Before You Start

`dev-mem-spec.md` at the repository root is the authoritative technical specification for this project. It defines the architecture, data model, non-negotiable constraints, and versioning plan. Any contribution that conflicts with it will not be merged without first updating the spec and getting maintainer agreement on the change. When in doubt, read the spec before opening an issue or writing code.

## Issue-First Policy

- Every pull request must reference an existing, maintainer-acknowledged issue (for example, "Fixes #12"). Pull requests without a linked issue may be closed.
- For anything beyond a trivial fix (typo, one-line bug), comment on the issue and wait for a maintainer to confirm the approach and assign it to you before writing code.
- Do not start work on an issue that is already assigned to someone else. Ask first.
- If you are assigned an issue and make no progress for 14 days without notice, it may be reassigned.
- New features, new commands, new dependencies, and architectural changes require an issue discussion and maintainer agreement before any code is written.

## Core Architectural Constraints

These are non-negotiable. A pull request that violates any of the following will be rejected regardless of code quality:

1. **Single LLM call site.** The entire codebase must contain exactly one place that makes an LLM API call: the batched extraction module. No other file, hook, or command may call an LLM, directly or indirectly. This is required to keep the tool's token cost measurable and bounded.
2. **Net token-neutral or better.** Dev-Mem must never increase a user's net token spend. Any change to capture, extraction, or retrieval must be evaluated against this constraint, not assumed to satisfy it.
3. **Deterministic capture first.** Anything that can be captured from git, the filesystem, or tool-call events without an LLM call must be implemented that way. LLM usage is reserved for extraction only.
4. **Local-first, no server.** Dev-Mem does not communicate with any hosted backend, telemetry service, or third-party server. All state lives in the user's own repository under `.dev-mem/`. Do not introduce a network dependency beyond the LLM API call made during extraction.
5. **Evidence is mandatory.** Every knowledge node written to the graph must carry a complete evidence record (commit, files, session ID, agent, timestamp, confidence) as defined in the spec. Do not relax this schema.
6. **Provider-neutral adapters.** Claude Code, Codex, Cursor, and OpenCode are all first-class. A change to `core/` must not assume or depend on the behavior of any single adapter. Adapter-specific logic belongs in `adapters/<agent>/`, not in `core/`.
7. **No external LLM provider SDKs.** LLM calls use the native Node.js `fetch` API directly, not `@anthropic-ai/sdk`, `openai`, or equivalent packages. This keeps the CLI's dependency footprint minimal.
8. **Hooks must never break the host agent.** Hook and adapter code is a best-effort observer. It must catch its own errors, must not block the host agent, and must never exit in a way that interrupts the user's session.

## Dependency Policy

Before adding any new runtime dependency to `package.json`, open an issue describing why it is needed and what native Node.js alternative was considered and rejected. Unsolicited pull requests that introduce a new runtime dependency without a prior issue discussion will not be merged. Development-only dependencies (TypeScript, Vitest, type definitions) are generally acceptable but must be justified in the pull request description. Do not add tooling (for example `ts-node`) that the project does not use.

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

Alternatively, run `npm link` to make the `dev-memo` command resolve to your local build for manual testing inside another repository.

## Scope and File Hygiene

A pull request must contain only the changes required by its linked issue. Reviewers will request changes for any of the following:

- **Unrelated changes.** Do not reformat files, rename things, bump versions, or "fix" code that is not part of the issue. Open a separate issue and pull request instead.
- **Config and manifest files.** Do not modify `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, or CI configuration unless the linked issue explicitly requires it. In particular:
  - Never commit lockfile churn caused by running `npm install` or `npm update`. If you do not change dependencies, `package-lock.json` must have no diff.
  - Do not add fields such as `main`, `author`, or `directories` to `package.json`.
- **Stray files.** Do not commit empty files, editor or OS files, build output (`dist/`), local `.dev-mem/` data, logs, or files with accidental names produced by a mistyped shell command. Review `git status` and `git diff --stat` before every commit.
- **Existing comments and docstrings.** Preserve existing comments and docstrings that are unrelated to your change. Do not delete documentation to shorten a diff.
- **Existing behavior.** Do not change default values (models, endpoints, URLs, timeouts, budgets) unless the issue asks for it. Values that look wrong must be raised in an issue first.
- **Review-process comments.** Comments in code must describe the code. Do not write comments such as "fixed as requested" or "restored per review".

## Code Style

- The project is written in TypeScript targeting native ES Modules. When importing a local file, the import specifier must include the `.js` extension, matching the compiled output (for example, `import { createNode } from './graph/index.js'`), even though the source file is `.ts`.
- Do not introduce a linter or formatter configuration change in a pull request that is not primarily about tooling. Keep formatting consistent with the surrounding file.
- Do not leave unreachable or dead code behind a return statement. If a function is refactored, delete the code it replaces in the same change.
- Do not duplicate logic across files. Extract shared behavior into a single helper (for example, retry handling shared by all LLM providers).
- Follow the idioms already used in the codebase, such as optional chaining for response parsing and standard `for` loops over contrived iteration constructs.
- Errors in hooks and extraction must be handled explicitly. Do not swallow errors silently without logging them.

## Testing

Tests use Vitest and are co-located with the code they test (for example, `core/graph/store.test.ts` tests `core/graph/index.ts`).

Requirements for any pull request that changes behavior:

- Every new feature must include a test that verifies actual output, not merely that the code runs without throwing.
- Every bug fix must include a test that reproduces the original failure and confirms the fix.
- Tests must not call real external services. Mock network calls (such as `fetch`) and use fake timers for anything involving delays or retries.
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

1. Confirm the linked issue is acknowledged and assigned to you (see [Issue-First Policy](#issue-first-policy)).
2. Create a branch: `feat/short-description` or `fix/short-description`.
3. Make your change, keeping it scoped to a single concern. Large, multi-purpose pull requests will be asked to be split.
4. Add or update tests as described above.
5. Run `npm run build` and `npm test` and confirm both succeed.
6. If the change affects `dev-mem-spec.md`'s description of current behavior (a new command, a changed config key, a changed default), update the spec in the same pull request. Do not let the spec drift from the implementation.
7. Write a clear commit history. Use concise, imperative commit messages (for example, `fix: retry LLM calls on 429 and 5xx`). Squash fixup and "update" commits before requesting review.
8. Write a pull request description that states what changed, why, and how it was tested, and reference the issue (for example, "Fixes #12").
9. Open the pull request against `main`.

## Pre-Submission Checklist

Copy this checklist into your pull request description and confirm every item. Unchecked items without an explanation will block review.

```markdown
- [ ] Linked to an acknowledged issue I was assigned to (Fixes #N)
- [ ] `npm run build` succeeds
- [ ] `npm test` succeeds
- [ ] New or changed behavior is covered by tests that verify real output
- [ ] The diff contains only changes required by the issue (checked with `git diff --stat`)
- [ ] No changes to `package.json`, `package-lock.json`, or `tsconfig.json` unless the issue requires them
- [ ] No new runtime dependency and no LLM provider SDK
- [ ] No stray, empty, generated, or accidentally named files
- [ ] Existing comments, docstrings, defaults, and endpoints are preserved
- [ ] `dev-mem-spec.md` is updated if documented behavior changed
- [ ] Eval harness results (before and after) are included if retrieval, regression, or extraction changed
- [ ] I have read and understood every line of this change (including any AI-generated code)
```

## Review and Merge Policy

- A maintainer reviews for correctness, adherence to the constraints above, scope discipline, and test coverage before merging.
- Review feedback must be addressed in full. Respond to each comment by pushing a fix or explaining why no change is needed. Do not resolve a maintainer's comment thread yourself.
- Push fixes as follow-up commits on the same branch; do not open a new pull request for the same change.
- Pull requests with no activity from the author for 14 days after a review request may be closed. They can be reopened on request.
- Pull requests that repeatedly ignore this document or earlier review feedback may be closed.
- Maintainers have final say on merging, scope, and direction. A pull request is not guaranteed to be accepted even if it follows every rule here.

## Use of AI Tools

AI-assisted contributions are welcome, but the contributor is fully responsible for the result. You must run the code, run the tests, and review the full diff yourself before submitting. Submissions containing unverified, unrelated, or hallucinated changes (for example, altered API endpoints, downgraded model names, or invented configuration) will be closed. Do not paste AI-generated review responses or explanations without verifying them.

## Reporting Issues

When opening an issue, include:

- What you expected to happen and what actually happened.
- The Dev-Mem version (`dev-memo --version` or the version in your `package.json`), Node.js version, and operating system.
- Which agent adapter is involved, if relevant (Claude Code, Codex, Cursor, or OpenCode).
- Steps to reproduce, including relevant contents of `.dev-mem/events.jsonl` or `dev-memo status` output if the issue involves capture, extraction, or retrieval.

Search existing issues first to avoid duplicates. Feature requests should describe the problem being solved, not only the proposed solution.

## Security

Do not report security vulnerabilities in public issues. Contact the maintainer privately through the contact details on the maintainer's GitHub profile, and include reproduction steps and the affected version. Never commit API keys, tokens, or real session data (`.dev-mem/` contents) to the repository.

## Code of Conduct

Be professional and respectful in all issues, pull requests, and discussions. Critique code, not people. Harassment, personal attacks, and discriminatory language are not tolerated and will result in removal from the project.

## License

By contributing to Dev-Mem, you agree that your contributions will be licensed under the MIT License, matching the project's existing license.
