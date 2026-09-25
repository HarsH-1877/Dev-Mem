import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmProvider, ProviderResolutionOptions } from "./types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";
import { createGeminiProvider } from "./gemini.js";

export type { LlmProvider, ProviderResolutionOptions } from "./types.js";
export { createAnthropicProvider } from "./anthropic.js";
export { createOpenAIProvider } from "./openai.js";
export { createGeminiProvider } from "./gemini.js";

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
  if (provider === "anthropic") {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (key) return createAnthropicProvider(key, model);
  }
  if (provider === "openai") {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (key) return createOpenAIProvider(key, model);
  }
  if (provider === "gemini") {
    const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (key) return createGeminiProvider(key, model);
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

/**
 * Reads LLM configuration from .dev-mem/config.yml and merges with env vars.
 * Config file values are lower priority than explicit env vars/options.
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
      const providerMatch = content.match(/^\s*llm_provider\s*:\s*['"]?([^'"\s]+)['"]?\s*$/m);
      const modelMatch = content.match(/^\s*llm_model\s*:\s*['"]?([^'"\s]+)['"]?\s*$/m);
      const baseUrlMatch = content.match(/^\s*llm_base_url\s*:\s*['"]?([^'"\s]+)['"]?\s*$/m);
      const apiKeyMatch = content.match(/^\s*llm_api_key\s*:\s*['"]?([^'"\s]+)['"]?\s*$/m);

      if (providerMatch) fileProvider = providerMatch[1];
      if (modelMatch) fileModel = modelMatch[1];
      if (baseUrlMatch) fileBaseUrl = baseUrlMatch[1];
      if (apiKeyMatch) fileApiKey = apiKeyMatch[1];
    } catch {
      // Ignore unreadable config
    }
  }

  // Explicit options take precedence over file configs
  return resolveProvider({
    provider: options?.provider !== undefined ? options.provider : fileProvider,
    model: options?.model !== undefined ? options.model : fileModel,
    baseUrl: options?.baseUrl !== undefined ? options.baseUrl : fileBaseUrl,
    apiKey: options?.apiKey !== undefined ? options.apiKey : fileApiKey,
  });
}
