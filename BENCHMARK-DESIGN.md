# Dev-Mem Benchmark Design (Phase 1)

## Objective
To rigorously evaluate Dev-Mem's core value proposition according to Section 11 of the specification. The evaluation must prove that Dev-Mem produces a **net-positive impact** on agent productivity by preventing redundant discovery and eliminating regression-repeats, without overwhelming the agent with noisy context.

## Required Metrics
1. **Redundant Discovery Avoided** (Primary): Did the agent re-investigate an architecture or codebase detail already known in the graph?
2. **Regression-repeat Rate**: How often does the agent re-attempt a known failed approach?
3. **Net Token Delta**: `(Tokens spent on capture + retrieval) - (Tokens saved by avoided rediscovery)`. Must be > 0.
4. **Task Success Rate**: Pass/fail rate on tasks heavily dependent on prior context.
5. **Time-to-completion (Wall Clock)**: Execution time with vs. without Dev-Mem.

## Test Harness Strategy
We will construct a fixed, deterministic test harness (`eval/harness/`) over a sample repository (`eval/sample-repo/`). 

### The Sequence (10-15 Tasks)
The sequence will consist of connected tasks where later tasks contain "traps" or hidden requirements that were discovered/decided in earlier tasks.

**Example Sequence (Draft):**
1. **Task 1 (Discovery/Decision):** Implement a feature. The agent discovers that `sqlite3` bindings fail in this environment, and switches to `better-sqlite3`. A `Decision` node is recorded.
2. **Task 2 (Unrelated):** Unrelated feature work. Ensures the knapsack algorithm doesn't pollute the context window.
3. **Task 3 (Regression Trap):** The agent is asked to implement a new data store. *Without Dev-Mem*, it will likely try `sqlite3` again (Regression-repeat). *With Dev-Mem*, RI should warn it immediately to use `better-sqlite3`.
4. **Task 4 (Constraint Trap):** A security constraint (e.g., "Use HttpOnly cookies, not localStorage") is established.
5. **Task 5 (Constraint Application):** A new auth flow is requested. The agent must adhere to the Task 4 constraint.

### Execution Plan (V1 Scope)
- **Agent**: Claude Code (Single-agent longitudinal testing)
- **Runs**: Execute the 15-task sequence 5 times with `Dev-Mem OFF`, and 5 times with `Dev-Mem ON`.
- **Measurement**: An automated script (`eval/run-eval.ts`) will orchestrate the agent, diff the transcripts, and compute the 5 required metrics.

## Next Steps
1. Author the 15 specific task prompts.
2. Build the `sample-repo` baseline.
3. Implement the `eval/run-eval.ts` orchestrator to run Claude Code headlessly and pipe input.
