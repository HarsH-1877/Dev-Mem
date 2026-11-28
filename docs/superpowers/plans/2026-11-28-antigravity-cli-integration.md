# Antigravity CLI (`agy`) Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deprecated Gemini CLI (`gemini`) integration with first-class **Google Antigravity (`agy`)** support — both as a zero-API-key host CLI extraction backend (`cli-agy`) and as a native coding agent adapter (`adapters/antigravity/` with `.agents/hooks.json`, `.agents/mcp_config.json`, `GEMINI.md` / `.agents/rules/` bootstrap).

**Architecture:** Two cleanly separated surfaces preserve Dev-Mem's core invariants:
1. **Extraction Provider (`core/llm/cli-agent.ts` + `core/llm/index.ts`):** Add `"agy"` as a `CliAgentKind` using `agy -p` (`--print`, optional `--model <model>`, prompt passed via `stdin`, spawned from `os.tmpdir()` with `DEV_MEM_DISABLE_HOOKS=1`). Deprecate standalone `"gemini"` CLI scanning while mapping `"cli-gemini"` cleanly as a backwards-compatible fallback alias to `"agy"` (keeping direct Gemini Developer API `GEMINI_API_KEY` via `core/llm/gemini.ts` intact).
2. **Antigravity Host Adapter (`adapters/antigravity/` + `cli/commands/install.ts`, `init.ts`, `bootstrap.ts`):** Normalize Antigravity's camelCase stdin payloads (`conversationId`, `workspacePaths`, `toolCall` / `tool_call`, `stepIdx`), install flat-array lifecycle handlers (`SessionStart`, `PreInvocation`, `PostInvocation`, `Stop`) and matcher-scoped tool handlers (`PreToolUse`, `PostToolUse`) into `.agents/hooks.json`, register `dev-memo mcp` in `.agents/mcp_config.json`, and mine `GEMINI.md` and `.agents/rules/*.md` during `dev-memo bootstrap` / `dev-memo init`.

**Tech Stack:** TypeScript (ESM `NodeNext`), Node.js >=22 built-ins (`node:child_process`, `node:fs`, `node:os`, `node:path`), Vitest, `better-sqlite3` (sole runtime dependency).

## Global Constraints

- Zero background daemons and zero open network ports.
- `better-sqlite3` remains the sole runtime dependency in `package.json`.
- No imports of `adapters/` or `cli/` from inside `core/`; no network calls outside `core/llm/` (enforced by `scripts/ci-check.mjs`).
- Node `>=22` compatible across Windows (`agy.exe` / `.cmd` shims, `where.exe`) and POSIX (`which`).
- All hooks must fail-open on Dev-Mem internal errors while respecting Antigravity's `PreToolUse` JSON contract (`{"decision":"allow"}` + optional `additionalContext`).

---

### Task 1: Replace Deprecated `gemini` CLI with Antigravity `agy` CLI Provider

**Files:**
- Modify: `core/llm/cli-agent.ts`
- Modify: `core/llm/index.ts`
- Modify: `core/llm/types.ts`
- Modify: `core/extraction/index.ts:255-262`
- Modify: `core/llm/cli-agent.test.ts`
- Modify: `core/llm/llm.test.ts`

**Interfaces:**
- Produces: `CliAgentKind = "claude" | "codex" | "agy"`, `mapSessionAgentToCli()` mapping `"antigravity"` / `"agy"` / `"antigravity-cli"` -> `"agy"`, `buildCliCommandSpec("agy", model)` producing `{ command: "agy", args: [...optional("--model", model), "-p", "..."] }`, and `resolveProvider()` supporting `"cli-agy"` / `"agy"` (with `"cli-gemini"` mapped safely to `"agy"` or legacy fallback).

- [ ] **Step 1: Verify local `agy` print/stdin invocation flags (manual check before tests)**

Run:
```powershell
agy --help
```
Expected: Lists `-p` / `--print` / `--prompt` and `--model` (note: `--output-format` and `--tools` do not exist on `agy` and must NOT be passed).

- [ ] **Step 2: Write the failing unit tests in `core/llm/cli-agent.test.ts` and `core/llm/llm.test.ts`**

Add to `core/llm/cli-agent.test.ts`:
```ts
it("maps antigravity/agy session agents and builds agy headless command spec", () => {
  expect(mapSessionAgentToCli("antigravity")).toBe("agy");
  expect(mapSessionAgentToCli("agy")).toBe("agy");
  expect(mapSessionAgentToCli("antigravity-cli")).toBe("agy");

  const agySpec = buildCliCommandSpec("agy", "gemini-3-flash");
  expect(agySpec.command).toBe("agy");
  expect(agySpec.args).toContain("--model");
  expect(agySpec.args).toContain("gemini-3-flash");
  expect(agySpec.args).toContain("-p");
  expect(agySpec.args).not.toContain("--output-format");
  expect(agySpec.args).not.toContain("--tools");

  const detected = detectAvailableCliAgents((bin) => bin === "claude" || bin === "agy");
  expect(detected).toEqual(["claude", "agy"]);
});
```

Add/update in `core/llm/llm.test.ts`:
```ts
it("prefers cli-agy for antigravity sessions and supports provider=cli-agy", () => {
  const matched = resolveProvider({
    sessionAgent: "antigravity",
    availableClis: ["claude", "agy"],
  });
  expect(matched?.name).toBe("cli-agy");

  const explicit = resolveProvider({ provider: "cli-agy" });
  expect(explicit?.name).toBe("cli-agy");

  // Legacy alias resolves cleanly without breaking existing config.yml
  const legacyAlias = resolveProvider({ provider: "cli-gemini" });
  expect(legacyAlias?.name).toBe("cli-agy");
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `npx vitest run core/llm/cli-agent.test.ts core/llm/llm.test.ts`
Expected: FAIL on `mapSessionAgentToCli("antigravity")` returning `null` and `cli-agy` returning `null`.

- [ ] **Step 4: Implement `agy` CLI support in `core/llm/cli-agent.ts`, `core/llm/index.ts`, `core/llm/types.ts`, and diagnostic messages**

In `core/llm/cli-agent.ts`:
```ts
export type CliAgentKind = "claude" | "codex" | "agy";

export const CLI_AGENT_KINDS: readonly CliAgentKind[] = ["claude", "codex", "agy"];

export function mapSessionAgentToCli(sessionAgent?: string): CliAgentKind | null {
  if (!sessionAgent) return null;
  const normalized = sessionAgent.trim().toLowerCase();
  if (normalized === "claude-code" || normalized === "claude") return "claude";
  if (normalized === "codex" || normalized === "codex-cli") return "codex";
  if (
    normalized === "antigravity" ||
    normalized === "agy" ||
    normalized === "antigravity-cli" ||
    normalized === "gemini" ||
    normalized === "gemini-cli"
  ) {
    return "agy";
  }
  return null;
}

export function buildCliCommandSpec(kind: CliAgentKind, model?: string): CliCommandSpec {
  switch (kind) {
    case "claude": {
      return {
        command: "claude",
        args: ["-p", "--model", model || "haiku", "--output-format", "text", "--no-session-persistence", "--tools", ""],
      };
    }
    case "codex": {
      const args = ["exec"];
      if (model) args.push("-m", model);
      args.push("-");
      return { command: "codex", args };
    }
    case "agy": {
      const args: string[] = [];
      if (model) args.push("--model", model);
      args.push("-p", "Follow the system instructions and output only valid JSON for the session log provided on stdin.");
      return { command: "agy", args };
    }
  }
}
```

In `core/llm/index.ts`:
```ts
if (provider === "cli-agy" || provider === "agy") {
  return createCliAgentProvider("agy", { model });
}
if (provider === "cli-gemini") {
  // Gemini CLI was deprecated in June 2026 and superseded by Antigravity CLI (`agy`).
  return createCliAgentProvider("agy", { model });
}
```
Update `core/llm/types.ts` JSDoc to list `"cli-agy"` (keeping `"gemini"` for API-key REST extraction) and update `core/extraction/index.ts:258-259` warning text from `(claude, codex, gemini)` to `(claude, codex, agy)`. Update any existing `"cli-gemini"` test assertions in `core/llm/cli-agent.test.ts` and `core/llm/llm.test.ts`.

- [ ] **Step 5: Run tests and typecheck to verify pass**

Run: `npm run typecheck; if ($?) { npx vitest run core/llm/cli-agent.test.ts core/llm/llm.test.ts }`
Expected: PASS across all tests in both suites.

- [ ] **Step 6: Commit Task 1**

```powershell
git add core/llm/cli-agent.ts core/llm/index.ts core/llm/types.ts core/extraction/index.ts core/llm/cli-agent.test.ts core/llm/llm.test.ts
git commit -m "feat(llm): replace deprecated gemini CLI backend with Antigravity agy CLI"
```

---

### Task 2: Add Antigravity Agent Adapter (`adapters/antigravity/`)

**Files:**
- Create: `adapters/antigravity/types.ts`
- Create: `adapters/antigravity/hook.ts`
- Create: `adapters/antigravity/index.ts`
- Create: `adapters/antigravity/antigravity.test.ts`

**Interfaces:**
- Consumes: `DeterministicCapture`, `retrieveContext`, `generateInjectionString`, `checkRegressionRisk`, `formatRegressionWarning`, `filterUnseenNodes`, `filterUnseenWarnings`, `importSharedGraph`, `retryPendingExtractions`, `parseHookPayload`
- Produces: Executable CLI hook entrypoint at `adapters/antigravity/hook.ts` handling `"SessionStart" | "PreInvocation" | "PreToolUse" | "PostToolUse" | "PostInvocation" | "Stop"`, normalizing camelCase Antigravity fields (`conversationId`, `workspacePaths`, `toolCall`/`tool_call`) and writing valid stdout JSON (`{ additionalContext }` or `{ decision: "allow", ... }`).

- [ ] **Step 1: Write the failing adapter test suite `adapters/antigravity/antigravity.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { GraphStore } from "../../core/graph/index.js";

describe("Antigravity CLI adapter hook", () => {
  let dir: string;
  const hookJs = join(process.cwd(), "dist", "adapters", "antigravity", "hook.js");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-agy-adapter-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@dev-mem.test"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# Test\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  });

  it("handles SessionStart with camelCase conversationId/workspacePaths and outputs additionalContext", () => {
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "Decision",
      title: "Use SQLite WAL mode for concurrent Antigravity hooks",
      content: "WAL avoids SQLITE_BUSY errors",
      lifecycle_state: "verified",
      evidence: {
        commit: "1111111111111111111111111111111111111111",
        files: ["README.md"],
        session_id: "prior-s",
        agent: "antigravity",
        timestamp: new Date().toISOString(),
        confidence: 0.95,
      },
    });
    store.close();

    const payload = {
      conversationId: "conv-agy-1",
      workspacePaths: [dir],
      hook_event_name: "SessionStart",
    };
    const res = spawnSync("node", [hookJs], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.additionalContext).toContain("SQLite WAL mode");
  });

  it("handles PreToolUse safely, returns decision=allow, and warns on FailedApproach file overlap", () => {
    const store = new GraphStore({ projectRoot: dir });
    store.createNode({
      type: "FailedApproach",
      title: "Modifying src/auth.ts without CSRF validation broke login",
      content: "Always check token origin",
      lifecycle_state: "active",
      evidence: {
        commit: "1111111111111111111111111111111111111111",
        files: ["src/auth.ts"],
        session_id: "prior-s",
        agent: "antigravity",
        timestamp: new Date().toISOString(),
        confidence: 0.9,
      },
    });
    store.close();

    const res = spawnSync("node", [hookJs, "--event", "PreToolUse"], {
      cwd: dir,
      input: JSON.stringify({
        conversationId: "conv-agy-2",
        workspacePaths: [dir],
        toolCall: { name: "replace_file_content", args: { TargetFile: "src/auth.ts", ReplacementContent: "login()" } },
      }),
      encoding: "utf8",
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.decision).toBe("allow");
    expect(out.additionalContext).toContain("Regression Intelligence");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run adapters/antigravity/antigravity.test.ts`
Expected: FAIL because `dist/adapters/antigravity/hook.js` does not exist yet.

- [ ] **Step 3: Create `adapters/antigravity/types.ts`, `adapters/antigravity/index.ts`, and `adapters/antigravity/hook.ts`**

Implement `adapters/antigravity/types.ts`:
```ts
export type AntigravityHookEvent =
  | "SessionStart"
  | "PreInvocation"
  | "PreToolUse"
  | "PostToolUse"
  | "PostInvocation"
  | "Stop";

export interface AntigravityRawHookInput {
  conversationId?: string;
  session_id?: string;
  workspacePaths?: string[];
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  message?: string;
  toolCall?: { name?: string; args?: Record<string, unknown> };
  tool_call?: { name?: string; args?: Record<string, unknown> };
  toolOutput?: unknown;
  exitCode?: number;
  [key: string]: unknown;
}
```

Implement `adapters/antigravity/hook.ts`:
- Check `if (process.env.DEV_MEM_DISABLE_HOOKS === "1") process.exit(0);` at top of `main()`.
- Accept optional `--event <EventName>` argv flag (supplied by per-event generated wrappers in `.agents/hooks/dev-mem-<event>.js`) OR `payload.hook_event_name`.
- Normalize `session_id = stringFor(raw.session_id, stringFor(raw.conversationId, ""))` and `cwd = stringFor(raw.cwd, Array.isArray(raw.workspacePaths) ? stringFor(raw.workspacePaths[0], process.cwd()) : process.cwd())`, then validate via `parseHookPayload(normalizedJson, EVENTS, "antigravity")`.
- Extract touched file targets across Antigravity tool names (`write_to_file`, `replace_file_content`, `multi_replace_file_content`, `Write`, `Edit`) from `TargetFile`, `file_path`, `path`, plus shell commands from `run_command` (`CommandLine`, `command`).
- On `SessionStart`: capture start + retry pending extractions + `importSharedGraph` + `checkRegressionRisk` + `retrieveContext({ currentSessionId: sessionId, ... })` + `filterUnseenNodes` + `filterUnseenWarnings`, print `{ additionalContext }`.
- On `PreInvocation`: run prompt-time `retrieveContext({ currentTask, currentSessionId, minRelevance: 0.08 })` + `filterUnseenNodes`, print `{ additionalContext }` if non-empty.
- On `PreToolUse`: record `exit_code: -1`, run `checkRegressionRisk` + `filterUnseenWarnings`, **always** print `JSON.stringify({ decision: "allow", ...(warning ? { additionalContext: warning } : {}) })`.
- On `PostToolUse`: record tool call completion (`exit_code` normalized via `numberFor`) and run regression check on file mutations.
- On `Stop`: record session end (`capture.endSession()`) and spawn detached `node <cliPath> extract <sessionId>` cleanly (always catching errors and exiting `0` so fail-closed Antigravity harness never blocks the user).

Export constants/metadata in `adapters/antigravity/index.ts`:
```ts
export const ANTIGRAVITY_LIFECYCLE_EVENTS = ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "Stop"] as const;
```

- [ ] **Step 4: Build and run tests to verify pass**

Run: `npm run build; if ($?) { npm run typecheck }; if ($?) { npx vitest run adapters/antigravity/antigravity.test.ts adapters/robustness.test.ts }`
Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add adapters/antigravity/
git commit -m "feat(antigravity): add Antigravity CLI/IDE lifecycle adapter with camelCase hook support"
```

---

### Task 3: Wire `antigravity` / `agy` into `install`, `init`, `doctor`, and `bootstrap`

**Files:**
- Modify: `cli/commands/install.ts`
- Modify: `cli/commands/init.ts`
- Modify: `cli/commands/diagnostics.ts`
- Modify: `core/bootstrap/index.ts`
- Modify: `cli/cli.test.ts`
- Modify: `core/bootstrap/bootstrap.test.ts`

**Interfaces:**
- Consumes: `ANTIGRAVITY_LIFECYCLE_EVENTS` or local event table in `install.ts`, `detectAvailableCliAgents()` returning `"agy"`
- Produces: `installHooks(cwd, ["antigravity"])` writing `.agents/hooks/dev-mem-<event>.js` and `.agents/hooks.json` (flat handler arrays for `SessionStart`, `PreInvocation`, `Stop`; matcher-wrapped handlers for `PreToolUse`, `PostToolUse`); `registerMcpConfigs()` writing `.agents/mcp_config.json`; `bootstrapProject()` scanning `GEMINI.md` and `.agents/rules/*.md`.

- [ ] **Step 1: Write the failing tests in `cli/cli.test.ts` and `core/bootstrap/bootstrap.test.ts`**

Add to `cli/cli.test.ts`:
```ts
describe("Antigravity CLI support in install, init, mcp, and uninstall", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-cli-agy-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# Agy\n", "utf8");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs .agents/hooks.json (flat lifecycle + matcher tool hooks) and registers .agents/mcp_config.json", async () => {
    const res = await runCli(["init", "antigravity", "--no-bootstrap"], { cwd: dir });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("antigravity");
    expect(existsSync(join(dir, ".agents", "hooks.json"))).toBe(true);
    expect(existsSync(join(dir, ".agents", "mcp_config.json"))).toBe(true);

    const hooksCfg = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"));
    expect(Array.isArray(hooksCfg["dev-memo"].SessionStart)).toBe(true);
    expect(Array.isArray(hooksCfg["dev-memo"].PreInvocation)).toBe(true);
    expect(hooksCfg["dev-memo"].PreToolUse[0].matcher).toBeDefined();

    const mcpCfg = JSON.parse(readFileSync(join(dir, ".agents", "mcp_config.json"), "utf8"));
    expect(mcpCfg.mcpServers["dev-memo"].command).toBe("npx");

    const un = await runCli(["uninstall"], { cwd: dir });
    expect(un.exitCode).toBe(0);
    const cleaned = JSON.parse(readFileSync(join(dir, ".agents", "hooks.json"), "utf8"));
    expect(cleaned["dev-memo"]).toBeUndefined();
  });
});
```

Add test in `core/bootstrap/bootstrap.test.ts` verifying `GEMINI.md` and `.agents/rules/security.md` rules are mined cleanly by `bootstrapProject`.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run cli/cli.test.ts -t "Antigravity CLI"`
Expected: FAIL with `Invalid agent: antigravity`.

- [ ] **Step 3: Update `cli/commands/install.ts`, `cli/commands/init.ts`, `cli/commands/diagnostics.ts`, and `core/bootstrap/index.ts`**

1. **`cli/commands/install.ts`:**
   - Extend `adapterHook` type to `"claude-code" | "codex" | "cursor" | "antigravity"` and pass `--event ${eventName}` in `getAntigravityHookScriptCode(eventName)` before importing `adapters/antigravity/hook.js` cleanly via `process.argv.push("--event", "${eventName}")`.
   - Implement `installAntigravityHooks(cwd)` & `uninstallAntigravityHooks(cwd)`:
     - Writes scripts to `.agents/hooks/dev-mem-<kebab-event>.js` containing `HOOK_MARKER`.
     - Upserts `hooksJson["dev-memo"]` in `.agents/hooks.json`:
       - `SessionStart`, `PreInvocation`, `Stop`: flat array `[{ type: "command", command: "node .agents/hooks/dev-mem-....js", timeout: 5 }]` (CRITICAL: NO `hooks` nesting, NO `matcher`).
       - `PreToolUse`, `PostToolUse`: `[{ matcher: "*", hooks: [{ type: "command", command: "node .agents/hooks/dev-mem-....js", timeout: 5 }] }]`.
   - Accept `"antigravity"` and alias `"agy"` -> `"antigravity"` in `installHooks()`.
   - Detect existing Antigravity workspace via `existsSync(join(cwd, ".agents")) || existsSync(join(cwd, "GEMINI.md"))`.
   - In `registerMcpConfigs()`, register `.agents/mcp_config.json` (`mcpServers["dev-memo"] = MCP_ENTRY`) when `agents.includes("antigravity")`.
   - Include `[".agents/hooks", /^dev-mem-.*\.js$/]` in `findStaleHooks()`.

2. **`cli/commands/init.ts`:**
   - Include `.agents` and `GEMINI.md` checks in `inferAgentsWhenEmpty(cwd)`.
   - Infer `"antigravity"` when `clis.includes("agy")` and update empty-provider message to mention `(claude/codex/agy)`.

3. **`cli/commands/diagnostics.ts`:**
   - Include `["antigravity", ".agents/hooks"]` in `runDoctor()`.

4. **`core/bootstrap/index.ts`:**
   - Add `"GEMINI.md"` to `DEFAULT_INSTRUCTION_FILES` and scan `join(".agents", "rules", "*.md")` alongside `.cursor/rules/`.

- [ ] **Step 4: Build, typecheck, and run tests**

Run: `npm run build; if ($?) { npm run typecheck }; if ($?) { npx vitest run cli/cli.test.ts core/bootstrap/bootstrap.test.ts adapters/antigravity/ }`
Expected: PASS across all tests.

- [ ] **Step 5: Commit Task 3**

```powershell
git add cli/commands/install.ts cli/commands/init.ts cli/commands/diagnostics.ts core/bootstrap/index.ts cli/cli.test.ts core/bootstrap/bootstrap.test.ts
git commit -m "feat(cli): add antigravity adapter install, MCP config, doctor, and GEMINI.md bootstrap"
```

---

### Task 4: Documentation Update, Live `agy` Smoke Test & Release `1.1.0`

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/Dev-Mem-Technical-Report.md`
- Modify: `cli/index.ts` (update `install` help text to include `antigravity`)
- Modify: `package.json`, `package-lock.json` (`1.1.0`)

- [ ] **Step 1: Update help text & documentation**

- Update `cli/index.ts` `helpText()` to mention `antigravity` alongside `claude-code, codex, cursor, opencode`.
- Update `README.md`: replace every `gemini` CLI / Gemini CLI reference with **Antigravity CLI (`agy`)**, add `antigravity` row to the Hooks table (`.agents/hooks.json`, `.agents/hooks/`), document `.agents/mcp_config.json`, document `GEMINI.md` and `.agents/rules/*.md` in bootstrap, while keeping `GEMINI_API_KEY` API fallback clear.
- Add `## 1.1.0` entry to `CHANGELOG.md` and update `docs/Dev-Mem-Technical-Report.md` Section 6.8 (CLI abstraction) & Section 7.2 (Agent Hook Mapping table).

- [ ] **Step 2: Bump version and run full verification gate**

Run:
```powershell
npm version 1.1.0 --no-git-tag-version; if ($?) { npm run build }; if ($?) { npm run typecheck }; if ($?) { npm test }; if ($?) { npm run ci:check }
```
Expected: All builds, typechecks, Vitest suites, and `ci:check` pass with exit code 0.

- [ ] **Step 3: Run live smoke test against local Antigravity `agy` CLI (optional when authenticated)**

Run:
```powershell
node dist/cli/index.js init antigravity
node dist/cli/index.js doctor --live
```
Expected: `.agents/hooks.json` and `.agents/mcp_config.json` created, `Extraction backend: cli-agy` detected.

- [ ] **Step 4: Commit release bump**

```powershell
git add cli/index.ts README.md CHANGELOG.md docs/Dev-Mem-Technical-Report.md package.json package-lock.json
git commit -m "chore: release 1.1.0 with Antigravity CLI (agy) support"
```
