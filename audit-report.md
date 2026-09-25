# Dev-Mem Pre-Publish Audit Report

This report summarizes the findings of the three-phase rigorous pre-publish audit.

## Phase 0: Baseline (Completed previously)
- **`npm install`**: Passed cleanly (native bindings for `better-sqlite3` compiled).
- **`npm run build`**: Passed cleanly (0 TS errors).
- **`npm test`**: Passed baseline (73/73 tests).
- **`npm pack --dry-run`**: Correctly scoped (59 files, `dist/`, `README.md`, `LICENSE`).

## Phase 1: Test Rigor (Coverage & Adversarial)

### 1b. Coverage Audit
Initial coverage scan with `vitest --coverage` identified the following coverage profiles for core modules:
- **`core/retrieval`**: 98.6% line / 82.6% branch
- **`core/regression`**: 92.6% line / 76.0% branch
- **`core/consistency`**: 93.8% line / 96.8% branch
- **`core/graph`**: 79.5% line / 77.2% branch
- **`core/extraction`**: 72.9% line / 61.6% branch
- **`core/capture`**: 82.1% line / 57.1% branch

**Risky Untested Branches Found:**
- `core/extraction` lacked tests for LLM timeouts or malformed non-JSON responses.
- `core/graph` lacked coverage for catastrophic database corruption (e.g., zero-byte file).
- `core/capture` lacked coverage for malformed `events.jsonl` files where valid lines precede broken lines.

### 1c. Adversarial Pass
New tests were added in `core/adversarial.test.ts` and `cli/adversarial.test.ts` (bringing total tests to 81/81 passing). These explicitly verified:
1. **Empty `.dev-mem/` startup**: Confirmed safe initialization with no prior graph.
2. **`graph.sqlite` corruption**: Zero-byte/truncated files correctly fail safe by propagating an intelligible SQLite error (`database disk image is malformed` or `file is not a database`) rather than hanging or silently corrupting.
3. **Malformed `events.jsonl`**: The `EventLog` parser explicitly checks for malformed lines during read and correctly throws an intelligible `Corrupt event log` error, failing safe instead of silently skipping data.
4. **LLM extraction failure**: A mock test returning broken non-JSON output confirmed `runExtraction` exits gracefully (`result.success = false`, `result.error` set) without crashing the background process.
5. **Scale testing (500+ nodes)**: Verified `adaptiveBudget()` correctly clamped the budget to 2000 tokens as expected (`clamp(n×18, 80, 2000)`), keeping query performance sub-second and context windows tight.
6. **CLI Hooks (Uninstall/Reinstall)**: Tested idempotence. Removing and reinstalling correctly leaves zero orphaned/duplicate hook scripts.
7. **`dev-mem wrap`**: Confirmed wrapping a crashing process (exit code 1) cleanly bubbles the exit code up without hanging the process or failing to flush.

## Phase 2: Code Quality Audit

### Type Safety & Error Handling
- **Type Casting (`as X`)**: Guarded `as X` usage in the event pipeline (`as GitSnapshotEvent`) is safely preceded by runtime `e.type === "..."` checks. The `core/hook-safety.ts` boundary validates payloads securely before casting `as Record<string, unknown>`. Type safety holds.
- **Filesystem Safety**: The `ensureLocalDataDir` function intentionally throws if directory creation or `.gitignore` appending fails (e.g., EACCES). However, all CLI entry points and adapter hooks (Claude Code, Codex, Cursor) wrap their entire main routine in `try { ... } catch (e) { ... }`, meaning the host IDE process will *never* crash due to a Dev-Mem filesystem failure.

### Configuration & SQLite Layer
- **WAL / Busy Handling**: Verified `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000` are configured on database instantiation, safely handling concurrent reads/writes.
- **Config Validation**: `core/checkpoint.ts` performs robust RegEx and integer validation on `extraction_event_threshold`, safely falling back to defaults.
- **Schema Versioning Gap [FLAGGED]**: `core/graph/schema.ts` uses `CREATE TABLE IF NOT EXISTS`. There is currently **no schema versioning** (e.g., `PRAGMA user_version` migrations). Any future addition or modification of columns will not seamlessly migrate existing `.dev-mem/graph.sqlite` files. This is acceptable for V2 but represents a real technical debt risk for V3 upgrades.
- **Documentation Drift [FIXED]**: Fixed comments in `schema.ts` and `README.md` that incorrectly referenced Node `22.13+` or `node:sqlite`. Both now properly state `22+` and `better-sqlite3`.

## Phase 3: Product & Real-World Impact (Dogfooding)

A fresh project (`dogfood-test`) was initialized using the packed `dev-mem-0.1.0.tgz` tarball. A Claude Code session was manually scripted (`simulate.mjs`) to pipe events into the hooks.

**Findings:**
1. **Extraction & Query**: A simulated mock LLM successfully populated the `graph.sqlite` database. Querying the task "Add logout to auth" against `src/auth.ts` injected clean, tight, `<dev_mem_context>` tags listing a related "Use JWT for auth" decision.
2. **Regression Intelligence**: When the script invoked a `SessionStart` simulating a second session with `src/auth.ts` containing `// testing session cookies`, Regression Intelligence successfully intercepted the file overlap and immediately injected a `<dev_mem_regression_warning>` for the "Session cookies failed" node directly into the CLI stdout context. The core value prop works reliably.
3. **Weakest Link & The Mock Gap [CRITICAL]**: The extraction step remains the weakest link. It entirely hinges on the quality of the LLM's summarization. **Crucially, the Phase 3 dogfooding test was run with a mocked LLM** because a real `ANTHROPIC_API_KEY` was unavailable in the test environment. While the plumbing (hook execution, JSON parsing, and Regression Intelligence injection) works flawlessly end-to-end with the mock, the actual *prompt design* and *LLM reliability* against real, messy code diffs remains unverified in this audit pass. If the LLM hallucinates poor nodes, the entire query and regression system degrades.
4. **Uninstall Threat**: Developers would uninstall this primarily if the background detached extraction tasks pile up, run slowly, consume too much RAM, or incur surprisingly high Anthropic API costs during heavy editing sessions. The Cursor N-event hook relies on background tasks that could theoretically accumulate if network latency spikes.

## Recommendation

**GO FOR PUBLISH PENDING REAL-LLM VERIFICATION.** The V2 exit criteria are technically met, the cross-agent graph transfers successfully, adversarial boundary cases are handled safely, and the core CLI works natively. However, because the core product value proposition (context extraction) was only validated against a mocked LLM response, you must manually run one real extraction with a live `ANTHROPIC_API_KEY` to confirm the prompt successfully yields valid JSON nodes before pushing to npm. The identified gap (schema migrations) does not block a V2 release.
