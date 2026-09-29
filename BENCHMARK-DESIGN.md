# Dev-Mem Benchmark Design (Phase 1)

## Objective
To rigorously evaluate Dev-Mem's core value proposition according to Section 11 of the specification. The evaluation must prove that Dev-Mem produces a **net-positive impact** on agent productivity by preventing redundant discovery and eliminating regression-repeats, without overwhelming the agent with noisy context.

## Known Scope Limitation Going In
Before results are generated, this benchmark explicitly pre-registers a known limitation discovered during Phase 0 dogdogfooding (see `docs/audit-report.md`, Follow-up Verification). 

The Regression Intelligence (RI) matching logic evaluates **exact file path overlaps only**. It does not perform semantic or conceptual matching of filenames. Therefore, RI is known *a priori* to miss regressions where an agent touches a conceptually related but physically distinct file (e.g., repeating a failed approach in `src/session-storage.js` when the original failure was recorded against `src/auth.js`). The benchmark corpus is deliberately designed to measure the impact of this limitation rather than hide it.

## Required Metrics
1. **Redundant Discovery Avoided** (Primary): Did the agent re-investigate an architecture or codebase detail already known in the graph?
2. **Regression-repeat Rate**: How often does the agent re-attempt a known failed approach? 
   * **Must be reported as a strict split**, not a blended aggregate:
     * *Exact-path hit rate*: % of avoided regressions on exact file matches.
     * *Near-miss hit rate*: % of avoided regressions on conceptually related but different files.
3. **Net Token Delta**: `(Tokens spent on capture + retrieval) - (Tokens saved by avoided rediscovery)`. Must be > 0.
4. **Task Success Rate**: Pass/fail rate on tasks heavily dependent on prior context. Evaluated via a strict, automated judge method (concrete test command or acceptance script written per task pair), rather than subjective human review.
5. **Time-to-completion (Wall Clock)**: Execution time with vs. without Dev-Mem.

**N=3 Variance and Uncertainty Reporting**: 
Because we are running N=3 iterations to account for LLM non-determinism, **every metric above will be reported as the mean plus the per-iteration spread/range**, never as an averaged number alone. 
Furthermore, it is pre-committed that the eventual `BENCHMARK-REPORT.md` will explicitly disclose in its uncertainty section that the near-miss subgroup constitutes a small sample size (7 pairs × 3 iterations = 21 data points), acknowledging the statistical limits of this sample prior to any drawn conclusions.

## Test Harness Strategy: The Task Corpus
We will construct a fixed, deterministic test harness (`eval/harness/`) over a sample repository (`eval/sample-repo/`). 

The corpus will consist of **15 Task Pairs (Task A / Task B)**. 
- **Task A (The Setup)**: The agent attempts a task, inevitably hits a hidden constraint or trap, and fails. The failed approach is captured.
- **Task B (The Trap)**: The agent is given a follow-up task where it will naturally try the same failed approach again unless Dev-Mem intervenes.

### The Realistic Mix (Split Corpus)
To prevent overstating real-world effectiveness or overly punishing the known limitation, the 15 pairs will be deliberately split and labeled into two groups:

1. **Exact-path pairs (8 pairs)**: 
   * *Definition*: Task B touches the exact same file(s) that Task A's failure was recorded against.
   * *Purpose*: Evaluates the confirmed "happy path" where RI is expected to successfully intervene.
   * *Task Success Judge Example*: Task B asks to implement token refresh in `auth.js`. 
     * **Acceptance Criterion**: Automated script runs `npm run test:auth` (must pass) and AST-scans `auth.js` to assert `localStorage` is completely absent.

2. **Near-miss pairs (7 pairs)**:
   * *Definition*: Task B touches a conceptually related file (a newly created file, a renamed file, or a different module implementing the same concept) where the failed approach still applies, but the filepath differs from Task A's evidence.
   * *Purpose*: Evaluates the real-world impact of the scope limitation confirmed in Phase 0.
   * *Task Success Judge Example*: Task B asks to create a new migration script `db/migrations/001.ts` connecting to the database.
     * **Acceptance Criterion**: Automated script runs `npm run test:db` (must pass) and regex-scans `001.ts` to ensure it successfully imports and invokes the `better-sqlite3` driver rather than falling back to `sqlite3`.

### State-Isolation Protocol (Hard Requirement)
To prevent knowledge bleed across iterations, the harness implements a strict isolation protocol. Before **EACH** of the N=3 iterations (in both the ON and OFF arms), the orchestrator is required to:
1. Perform a full, destructive wipe of the `.dev-mem/` directory.
2. Perform a fresh `git reset --hard` and `git clean -fd` in `eval/sample-repo/` to reset all code state.

Without this hard requirement, later iterations would inherit knowledge or file states from earlier ones, corrupting the metrics completely.

## Execution Plan (V1 Scope)
- **Agent**: Claude Code (Single-agent longitudinal testing)
- **Runs**: Execute the 15-pair sequence across both arms (`Dev-Mem OFF` and `Dev-Mem ON`) for N=3 iterations (approved budget: ~$19.50).
- **Compiled Product Surface**: `eval/run-eval.ts` must orchestrate the agent such that it drives the compiled `dist/` CLI and hooks exclusively (the identical standard used in the tightened Phase 0 verification). No direct internal TypeScript function calls are permitted during the evaluation.
- **Measurement**: `eval/run-eval.ts` will diff the transcripts and compute the required split metrics against the defined automated acceptance criteria.
