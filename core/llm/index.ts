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
