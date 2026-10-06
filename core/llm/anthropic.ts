// core/llm/anthropic.ts
import type { LlmProvider } from "./types.js";

// Reverted to the original official Anthropic API endpoint to avoid 404/405 errors
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
// Restored the proper default model as requested by the mentor
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

export function createAnthropicProvider(apiKey: string, model?: string): LlmProvider {
  const useModel = model || DEFAULT_MODEL;

  return {
    name: "anthropic",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      let currentResponse: Response | null = null;
      const maxRetries = 4;

      // Refactored to standard for-loop syntax instead of Array.of(...)
      for (let i = 0; i < maxRetries; i++) {
        try {
          const res = await fetch(ANTHROPIC_API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01" // Required header for Anthropic API
            },
            body: JSON.stringify({
              model: useModel,
              max_tokens: maxTokens,
              system: system || undefined, // Anthropic expects system prompt at root level
              messages: [
                { role: "user", content: prompt }
              ]
            })
          });

          currentResponse = res;

          if (res.ok) {
            break;
          }

          // Directly checking expanded retryable server errors: 429, 500, 502, 503, 504
          const status = res.status;
          const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

          if (!isRetryable) {
            break;
          }
        } catch (error) {
          if (i === maxRetries - 1) throw error;
        }

        // Apply exponential backoff with randomized jitter before the next retry
        if (i < maxRetries - 1) {
          const jitterDelay = Math.pow(2, i) * 1000 + Math.random() * 1000;
          await new Promise<void>((resolve) => setTimeout(resolve, jitterDelay));
        }
      }

      if (!currentResponse) {
        throw new Error("Anthropic API invocation broke down: No response captured.");
      }

      if (!currentResponse.ok) {
        const errBody = await currentResponse.text();
        throw new Error(`Anthropic API error (${currentResponse.status}): ${errBody}`);
      }

      const data = (await currentResponse.json()) as any;

      // Retained clean optional chaining for extracting text data
      return data?.content?.[0]?.text || "";
    }
  };
}
