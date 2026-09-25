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
