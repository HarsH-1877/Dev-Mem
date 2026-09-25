# Multi-Provider LLM Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded Anthropic-only extraction call with a provider-agnostic LLM layer that auto-detects which API key the user has and uses whichever provider is available — zero new dependencies, zero configuration required for users who already have any standard API key set.

**Architecture:** Introduce a thin `LlmProvider` interface (`core/llm/`) with four concrete implementations — Anthropic, OpenAI, Gemini, and OpenAI-compatible (covers Ollama, Groq, OpenRouter, DeepSeek, etc.). Provider selection is automatic via environment variable detection with a configurable override in `.dev-mem/config.yml`. The extraction call site (`core/extraction/index.ts`) delegates to whichever provider is resolved, keeping the prompt and JSON parsing logic unchanged.

**Tech Stack:** Plain TypeScript, Node.js `fetch` API only — zero new npm dependencies.

## Global Constraints

- **No new npm dependencies.** All LLM calls use native `fetch`. No `openai` SDK, no `@anthropic-ai/sdk`, no LiteLLM.
- **Single LLM call site remains `core/extraction/index.ts`.** The provider abstraction lives below it; extraction logic does not change.
- **Local-first, no server.** No hosted backend or proxy. All calls go directly from the user's machine to the provider's API.
- **Provider-neutral (spec §4.6).** No provider is privileged over another. Anthropic remains supported but is no longer the only option.
- **Backwards compatible.** Existing users with `ANTHROPIC_API_KEY` experience zero breakage. The existing mock/test pathways remain unchanged.
- **`better-sqlite3` is the only runtime dependency.** This does not change.
- All existing 81 tests must continue passing after every task.

---

### Task 1: LLM Provider Interface & Anthropic Implementation (extract from existing code)

**Files:**
- Create: `core/llm/types.ts`
- Create: `core/llm/anthropic.ts`
- Create: `core/llm/index.ts`
- Test: `core/llm/llm.test.ts`

**Interfaces:**
- Consumes: Nothing (new foundation)
- Produces:
  - `LlmProvider` interface: `{ complete(system: string, prompt: string, maxTokens: number): Promise<string> }`
  - `createAnthropicProvider(apiKey: string, model?: string): LlmProvider`
  - `resolveProvider(options?: { apiKey?: string; provider?: string; model?: string }): LlmProvider | null`

- [ ] **Step 1: Write the failing test for the provider interface and Anthropic implementation**

```typescript
// core/llm/llm.test.ts
import { describe, expect, it } from "vitest";
import { resolveProvider } from "./index.js";

describe("LLM Provider Resolution", () => {
  it("returns null when no API keys are available", () => {
    // Temporarily clear all relevant env vars
    const saved = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.DEV_MEM_LLM_BASE_URL;
    
    const provider = resolveProvider();
    expect(provider).toBeNull();

    Object.assign(process.env, saved);
  });

  it("resolves Anthropic provider when ANTHROPIC_API_KEY is set", () => {
    const provider = resolveProvider({ apiKey: "test-key", provider: "anthropic" });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("anthropic");
  });

  it("resolves OpenAI provider when OPENAI_API_KEY is passed", () => {
    const provider = resolveProvider({ apiKey: "test-key", provider: "openai" });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("openai");
  });

  it("resolves OpenAI-compatible provider when base URL is passed", () => {
    const provider = resolveProvider({ apiKey: "ollama", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1" });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("openai-compatible");
  });

  it("resolves Gemini provider when GEMINI_API_KEY is passed", () => {
    const provider = resolveProvider({ apiKey: "test-key", provider: "gemini" });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/llm/llm.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Create `core/llm/types.ts` — the provider interface**

```typescript
// core/llm/types.ts

/**
 * Minimal LLM provider interface for Dev-Mem extraction.
 * Each provider translates this into its own API format.
 * No SDK dependencies — all implementations use native fetch.
 */
export interface LlmProvider {
  /** Human-readable provider name for diagnostics */
  readonly name: string;

  /**
   * Single-turn completion. Returns the raw text response.
   * Throws on network/API errors with a descriptive message.
   */
  complete(system: string, prompt: string, maxTokens: number): Promise<string>;
}

export interface ProviderResolutionOptions {
  /** Explicit API key (overrides env var) */
  apiKey?: string;
  /** Force a specific provider: "anthropic" | "openai" | "gemini" | "openai-compatible" */
  provider?: string;
  /** Model override (e.g. "gpt-4o", "claude-3-5-sonnet-20241022") */
  model?: string;
  /** Base URL for OpenAI-compatible endpoints (e.g. Ollama, Groq) */
  baseUrl?: string;
}
```

- [ ] **Step 4: Create `core/llm/anthropic.ts` — extracted from current extraction code**

```typescript
// core/llm/anthropic.ts
import type { LlmProvider } from "./types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

export function createAnthropicProvider(apiKey: string, model?: string): LlmProvider {
  const useModel = model || DEFAULT_MODEL;
  return {
    name: "anthropic",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errBody}`);
      }

      const data = (await response.json()) as any;
      const block = data?.content?.find((c: any) => c.type === "text");
      return block?.text || "";
    },
  };
}
```

- [ ] **Step 5: Create `core/llm/index.ts` — provider resolution with auto-detection**

```typescript
// core/llm/index.ts
import type { LlmProvider, ProviderResolutionOptions } from "./types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createGeminiProvider } from "./gemini.js";

export type { LlmProvider, ProviderResolutionOptions } from "./types.js";

/**
 * Resolves an LLM provider based on explicit options or environment variables.
 *
 * Priority order (first match wins):
 * 1. Explicit `provider` + `apiKey` in options
 * 2. DEV_MEM_LLM_PROVIDER + DEV_MEM_LLM_API_KEY env vars (user override)
 * 3. DEV_MEM_LLM_BASE_URL env var (OpenAI-compatible, e.g. Ollama)
 * 4. ANTHROPIC_API_KEY env var
 * 5. OPENAI_API_KEY env var
 * 6. GEMINI_API_KEY or GOOGLE_API_KEY env var
 *
 * Returns null if no usable provider is found.
 */
export function resolveProvider(options?: ProviderResolutionOptions): LlmProvider | null {
  const provider = options?.provider || process.env.DEV_MEM_LLM_PROVIDER;
  const apiKey = options?.apiKey || process.env.DEV_MEM_LLM_API_KEY;
  const baseUrl = options?.baseUrl || process.env.DEV_MEM_LLM_BASE_URL;
  const model = options?.model || process.env.DEV_MEM_LLM_MODEL;

  // 1. Explicit provider requested
  if (provider === "anthropic" && apiKey) {
    return createAnthropicProvider(apiKey, model);
  }
  if (provider === "openai" && apiKey) {
    return createOpenAIProvider(apiKey, model);
  }
  if (provider === "gemini" && apiKey) {
    return createGeminiProvider(apiKey, model);
  }
  if (provider === "openai-compatible" && baseUrl) {
    return createOpenAIProvider(apiKey || "ollama", model, baseUrl);
  }

  // 2. OpenAI-compatible base URL (covers Ollama, Groq, OpenRouter, LM Studio)
  if (baseUrl) {
    return createOpenAIProvider(apiKey || "ollama", model, baseUrl);
  }

  // 3. Auto-detect from well-known env vars
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return createAnthropicProvider(anthropicKey, model);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return createOpenAIProvider(openaiKey, model);
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    return createGeminiProvider(geminiKey, model);
  }

  return null;
}
```

Note: This references `createOpenAIProvider` and `createGeminiProvider` which are built in Tasks 2-3. For this step, create temporary stubs:

```typescript
// core/llm/openai.ts (stub — replaced in Task 2)
import type { LlmProvider } from "./types.js";
export function createOpenAIProvider(apiKey: string, model?: string, baseUrl?: string): LlmProvider {
  throw new Error("OpenAI provider not yet implemented");
}
```

```typescript
// core/llm/gemini.ts (stub — replaced in Task 3)
import type { LlmProvider } from "./types.js";
export function createGeminiProvider(apiKey: string, model?: string): LlmProvider {
  throw new Error("Gemini provider not yet implemented");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run core/llm/llm.test.ts`
Expected: 5 PASS

- [ ] **Step 7: Run full test suite to verify no regressions**

Run: `npm test`
Expected: All 81+ tests pass (new tests add to count).

- [ ] **Step 8: Commit**

```bash
git add core/llm/
git commit -m "feat: add LlmProvider interface and Anthropic implementation"
```

---

### Task 2: OpenAI Provider Implementation

**Files:**
- Modify: `core/llm/openai.ts` (replace stub)
- Modify: `core/llm/llm.test.ts` (add OpenAI-specific tests)

**Interfaces:**
- Consumes: `LlmProvider` from Task 1
- Produces: `createOpenAIProvider(apiKey: string, model?: string, baseUrl?: string): LlmProvider`

- [ ] **Step 1: Write the failing test for the OpenAI provider structure**

Add to `core/llm/llm.test.ts`:

```typescript
import { createOpenAIProvider } from "./openai.js";

describe("OpenAI Provider", () => {
  it("creates a provider with the correct name", () => {
    const provider = createOpenAIProvider("test-key");
    expect(provider.name).toBe("openai");
  });

  it("creates an openai-compatible provider when baseUrl is given", () => {
    const provider = createOpenAIProvider("ollama", undefined, "http://localhost:11434/v1");
    expect(provider.name).toBe("openai-compatible");
  });

  it("has a complete method", () => {
    const provider = createOpenAIProvider("test-key");
    expect(typeof provider.complete).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/llm/llm.test.ts`
Expected: FAIL — stub throws.

- [ ] **Step 3: Implement `core/llm/openai.ts`**

```typescript
// core/llm/openai.ts
import type { LlmProvider } from "./types.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * OpenAI and OpenAI-compatible provider (Ollama, Groq, OpenRouter, LM Studio, DeepSeek).
 * Uses the standard /v1/chat/completions endpoint.
 * When baseUrl is provided, it replaces the OpenAI URL — this is how Ollama and similar tools work.
 */
export function createOpenAIProvider(apiKey: string, model?: string, baseUrl?: string): LlmProvider {
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    : OPENAI_API_URL;
  const useModel = model || (baseUrl ? "llama3.1" : DEFAULT_MODEL);
  const isCompatible = !!baseUrl;

  return {
    name: isCompatible ? "openai-compatible" : "openai",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        const label = isCompatible ? "OpenAI-compatible" : "OpenAI";
        throw new Error(`${label} API error (${response.status}): ${errBody}`);
      }

      const data = (await response.json()) as any;
      return data?.choices?.[0]?.message?.content || "";
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/llm/llm.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add core/llm/openai.ts core/llm/llm.test.ts
git commit -m "feat: add OpenAI and OpenAI-compatible LLM provider"
```

---

### Task 3: Gemini Provider Implementation

**Files:**
- Modify: `core/llm/gemini.ts` (replace stub)
- Modify: `core/llm/llm.test.ts` (add Gemini-specific tests)

**Interfaces:**
- Consumes: `LlmProvider` from Task 1
- Produces: `createGeminiProvider(apiKey: string, model?: string): LlmProvider`

- [ ] **Step 1: Write the failing test for the Gemini provider structure**

Add to `core/llm/llm.test.ts`:

```typescript
import { createGeminiProvider } from "./gemini.js";

describe("Gemini Provider", () => {
  it("creates a provider with the correct name", () => {
    const provider = createGeminiProvider("test-key");
    expect(provider.name).toBe("gemini");
  });

  it("has a complete method", () => {
    const provider = createGeminiProvider("test-key");
    expect(typeof provider.complete).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/llm/llm.test.ts`
Expected: FAIL — stub throws.

- [ ] **Step 3: Implement `core/llm/gemini.ts`**

```typescript
// core/llm/gemini.ts
import type { LlmProvider } from "./types.js";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.0-flash";

/**
 * Google Gemini provider.
 * Uses the Gemini generateContent REST API with an API key.
 * Supports GEMINI_API_KEY or GOOGLE_API_KEY.
 */
export function createGeminiProvider(apiKey: string, model?: string): LlmProvider {
  const useModel = model || DEFAULT_MODEL;
  return {
    name: "gemini",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      const url = `${GEMINI_API_URL}/${useModel}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errBody}`);
      }

      const data = (await response.json()) as any;
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run core/llm/llm.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add core/llm/gemini.ts core/llm/llm.test.ts
git commit -m "feat: add Gemini LLM provider"
```

---

### Task 4: Rewire `core/extraction/index.ts` to Use the Provider Abstraction

**Files:**
- Modify: `core/extraction/index.ts` (lines 9, 11-18, 215-247)
- Test: `core/extraction/extraction.test.ts` (existing tests must still pass)

**Interfaces:**
- Consumes: `resolveProvider()` from Task 1, `LlmProvider.complete()` from Tasks 1-3
- Produces: Same `ExtractionResult` — no public API change. The `ExtractionOptions` interface gains an optional `provider` and `baseUrl` field.

- [ ] **Step 1: Write the failing test for multi-provider extraction**

Add to `core/extraction/extraction.test.ts`:

```typescript
it("reports a clear error when no LLM provider is available (no env key set)", async () => {
  const saved = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEV_MEM_LLM_BASE_URL;
  delete process.env.DEV_MEM_LLM_API_KEY;

  const result = await runExtraction({
    projectRoot: testDir,
    sessionId: "provider-test",
  });

  expect(result.success).toBe(false);
  expect(result.error).toContain("No LLM provider");

  Object.assign(process.env, saved);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/extraction/extraction.test.ts`
Expected: FAIL — current code says "No ANTHROPIC_API_KEY" not "No LLM provider".

- [ ] **Step 3: Rewire `core/extraction/index.ts`**

Replace the hardcoded Anthropic block (lines 9, 215-247) with provider delegation:

1. Remove: `const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";` (line 9)
2. Add import: `import { resolveProvider } from "../llm/index.js";`
3. Add `provider?: string` and `baseUrl?: string` to `ExtractionOptions`
4. Replace the entire LLM call block (lines 215-247) with:

```typescript
    } else {
      const llm = resolveProvider({
        apiKey,
        provider: options.provider,
        model,
        baseUrl: options.baseUrl,
      });
      if (!llm) {
        console.warn("[dev-mem] No LLM provider available. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or DEV_MEM_LLM_BASE_URL. Skipping extraction.");
        return { success: false, nodes: [], error: "No LLM provider available — set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or DEV_MEM_LLM_BASE_URL" };
      }

      try {
        responseText = await llm.complete(
          "You extract structured development knowledge nodes from session event logs. Return JSON only.",
          prompt,
          4096,
        );
      } catch (llmErr: any) {
        const msg = `LLM call failed (${llm.name}): ${llmErr.message}`;
        console.error(`[dev-mem] ${msg}`);
        return { success: false, nodes: [], error: msg };
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass (81+ tests). The existing mock pathways (`mockLlm`, `customLlmResponse`) are untouched and still work because the provider code is only reached in the `else` branch.

- [ ] **Step 5: Commit**

```bash
git add core/extraction/index.ts core/extraction/extraction.test.ts
git commit -m "feat: rewire extraction to use multi-provider LLM resolution"
```

---

### Task 5: Config File Support & Updated Documentation

**Files:**
- Modify: `core/llm/index.ts` (add config.yml reading)
- Modify: `README.md` (update requirements section and add provider configuration docs)
- Modify: `dev-mem-spec.md` (update §7.2 to document provider-neutral extraction)
- Test: `core/llm/llm.test.ts` (add config.yml test)

**Interfaces:**
- Consumes: `resolveProvider()` from Task 1
- Produces: No new public API. `resolveProvider` now also reads `.dev-mem/config.yml` for `llm_provider`, `llm_model`, `llm_base_url`.

- [ ] **Step 1: Write the failing test for config.yml-based provider selection**

Add to `core/llm/llm.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProviderForProject } from "./index.js";

describe("Config-based provider resolution", () => {
  it("reads llm_provider and llm_base_url from .dev-mem/config.yml", () => {
    const cwd = mkdtempSync(join(tmpdir(), "dev-mem-llm-cfg-"));
    try {
      mkdirSync(join(cwd, ".dev-mem"));
      writeFileSync(join(cwd, ".dev-mem", "config.yml"),
        "llm_provider: openai-compatible\nllm_base_url: http://localhost:11434/v1\n"
      );

      const provider = resolveProviderForProject(cwd);
      expect(provider).not.toBeNull();
      expect(provider!.name).toBe("openai-compatible");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run core/llm/llm.test.ts`
Expected: FAIL — `resolveProviderForProject` doesn't exist.

- [ ] **Step 3: Add `resolveProviderForProject` to `core/llm/index.ts`**

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads LLM configuration from .dev-mem/config.yml and merges with env vars.
 * Config file values are lower priority than explicit env vars.
 */
export function resolveProviderForProject(projectRoot: string, options?: ProviderResolutionOptions): LlmProvider | null {
  const configPath = join(projectRoot, ".dev-mem", "config.yml");
  let fileProvider: string | undefined;
  let fileModel: string | undefined;
  let fileBaseUrl: string | undefined;
  let fileApiKey: string | undefined;

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf8");
      const providerMatch = content.match(/^\s*llm_provider\s*:\s*(\S+)\s*$/m);
      const modelMatch = content.match(/^\s*llm_model\s*:\s*(\S+)\s*$/m);
      const baseUrlMatch = content.match(/^\s*llm_base_url\s*:\s*(\S+)\s*$/m);
      const apiKeyMatch = content.match(/^\s*llm_api_key\s*:\s*(\S+)\s*$/m);

      if (providerMatch) fileProvider = providerMatch[1];
      if (modelMatch) fileModel = modelMatch[1];
      if (baseUrlMatch) fileBaseUrl = baseUrlMatch[1];
      if (apiKeyMatch) fileApiKey = apiKeyMatch[1];
    } catch {
      // Ignore unreadable config
    }
  }

  return resolveProvider({
    provider: options?.provider || fileProvider,
    model: options?.model || fileModel,
    baseUrl: options?.baseUrl || fileBaseUrl,
    apiKey: options?.apiKey || fileApiKey,
    ...options,
  });
}
```

- [ ] **Step 4: Update `core/extraction/index.ts` to use `resolveProviderForProject`**

Replace `resolveProvider(...)` call with `resolveProviderForProject(projectRoot, ...)`.

- [ ] **Step 5: Update README.md requirements section**

Replace:
```markdown
- `ANTHROPIC_API_KEY` in your environment (used by the extraction step only)
```
With:
```markdown
- An LLM API key for the extraction step — any ONE of:
  - `ANTHROPIC_API_KEY` (Claude)
  - `OPENAI_API_KEY` (GPT-4o / GPT-4o-mini)
  - `GEMINI_API_KEY` or `GOOGLE_API_KEY` (Gemini)
  - `DEV_MEM_LLM_BASE_URL` pointed at any OpenAI-compatible endpoint (Ollama, Groq, OpenRouter, LM Studio, DeepSeek) — no API key required for local Ollama
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add core/llm/ core/extraction/index.ts README.md dev-mem-spec.md
git commit -m "feat: add config.yml LLM provider support, update docs for multi-provider"
```

---

## Self-Review

**Spec coverage:**
- §4.6 (Provider-neutral): ✅ Now satisfied at the LLM layer, not just the adapter layer.
- §4.4 (Local-first, no server): ✅ Ollama support means zero external dependency is possible.
- §7.2 (Single LLM call site): ✅ Extraction still has one call site; it just delegates to a resolved provider.
- §4.3 (No new dependencies): ✅ All implementations use native `fetch`.

**Placeholder scan:** No TBDs, TODOs, or "implement later" found. All code blocks are complete.

**Type consistency:** `LlmProvider`, `resolveProvider`, `resolveProviderForProject`, `createAnthropicProvider`, `createOpenAIProvider` — names are consistent across all tasks.

---

Plan complete and saved to `docs/superpowers/plans/2026-09-24-multi-provider-llm.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
