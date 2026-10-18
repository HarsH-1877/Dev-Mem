# Terminal Logo Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a high-density solid 3D ASCII logo banner for `dev-memo` displayed during `dev-memo install` and when running `dev-memo` without arguments or `--help`.

**Architecture:** Create an isolated `cli/banner.ts` module providing `getBanner()`, respecting dynamic versioning and `NO_COLOR` / TTY styling. Integrate cleanly into `cli/index.ts` without touching operational commands or agent hooks.

**Tech Stack:** TypeScript, Node.js ES Modules, native ANSI escape codes, Vitest.

## Global Constraints
- Zero external runtime dependencies.
- Never display during background agent hook executions (`SessionStart`, `PostToolUse`, `SessionEnd`).
- Never display during operational commands (`status`, `query`, `inspect`, `doctor`, `prune`, `sync`, `extract`, `wrap`, `uninstall`).
- Color output must be suppressed when `process.env.NO_COLOR` is present or stdout is not a TTY.

---

### Task 1: Create `cli/banner.ts` and Unit Tests

**Files:**
- Create: `cli/banner.ts`
- Create: `cli/banner.test.ts`

**Interfaces:**
- Produces: `getBanner(options?: { noColor?: boolean; version?: string }): string`

- [ ] **Step 1: Write the failing unit tests for `getBanner()`**
  Create `cli/banner.test.ts` testing:
  - Outputs the exact ASCII string with `DEV-MEM`.
  - Includes tagline and current version.
  - Overrides version cleanly when passed in options.
  - Suppresses ANSI escape codes when `noColor: true` or `process.env.NO_COLOR` is set.

- [ ] **Step 2: Run the test to confirm it fails**
  Run `npx vitest run cli/banner.test.ts` and confirm failure (module not found).

- [ ] **Step 3: Implement `cli/banner.ts`**
  Implement `getBanner()` using Variation 1 ASCII art with clean ANSI formatting and `package.json` version discovery.

- [ ] **Step 4: Run the test to confirm it passes**
  Run `npx vitest run cli/banner.test.ts` and confirm all tests pass.

- [ ] **Step 5: Commit changes**
  Run `git add cli/banner.ts cli/banner.test.ts && git commit -m "feat(cli): add banner module with unit tests"`

---

### Task 2: Integrate Banner into `cli/index.ts`

**Files:**
- Modify: `cli/index.ts`
- Test: `cli/banner.test.ts` (extend with CLI execution tests)

**Interfaces:**
- Consumes: `getBanner(options?: { noColor?: boolean; version?: string }): string` from `cli/banner.js`
- Modifies: `runCli(args, options)` in `cli/index.ts`

- [ ] **Step 1: Write failing CLI integration test**
  Add tests in `cli/banner.test.ts` that call `runCli([])`, `runCli(["--help"])`, and `runCli(["install"])` and verify `stdout` starts with the banner. Verify `runCli(["status"])` does NOT contain the banner.

- [ ] **Step 2: Run test to confirm failure**
  Run `npx vitest run cli/banner.test.ts` and confirm the new integration assertions fail.

- [ ] **Step 3: Update `cli/index.ts`**
  - Import `getBanner` from `./banner.js`.
  - In `runCli`:
    - If `args.length === 0` or `args[0] === "--help"` or `args[0] === "-h"`: prepend `getBanner()` to formatted help output.
    - If `command === "install"`: prepend `getBanner() + "\n"` to install stdout.

- [ ] **Step 4: Run all tests to confirm they pass**
  Run `npm test` across the full test suite.

- [ ] **Step 5: Verify build**
  Run `npm run build` to verify `dist/` builds without type errors.

- [ ] **Step 6: Commit changes**
  Run `git add cli/index.ts cli/banner.test.ts && git commit -m "feat(cli): display logo banner on install and help"`
