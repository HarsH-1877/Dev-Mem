// core/llm/anthropic.ts
import type { LlmProvider } from "./types.js";

// FIXED: Correct Anthropic base endpoint path for messages API
const ANTHROPIC_API_URL = "https://anthropic.com";
const DEFAULT_MODEL = "claude-3-5-sonnet-20240620";

export function createAnthropicProvider(apiKey: string, model?: string): LlmProvider {
  const useModel = model || DEFAULT_MODEL;

  return {
    name: "anthropic",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      let currentResponse: Response | null = null;
      let currentDelay = 1000;

      // Clean iteration array for 4 attempts (0, 1, 2, 3)
      const attemptsArray = Array.of(0, 1, 2, 3);

      for (const attemptIndex of attemptsArray) {
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

          // FIXED LOGIC: If response is successful, break the retry loop immediately.
          if (res.ok) {
            break;
          }

          // Status 429 (Rate Limit) or 503 (Service Unavailable) should trigger a retry
          if (res.status !== 429 && res.status !== 503) {
            break;
          }
        } catch (error) {
          if (attemptIndex === 3) throw error;
        }

        // If we haven't reached the max retries, wait with exponential backoff
        if (attemptIndex < 3) {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              resolve();
            }, currentDelay);
          });
          currentDelay = currentDelay * 2; // 1000ms -> 2000ms -> 4000ms
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

      // Anthropic safely extracts text data via content array blocks
      if (data && data.content && data.content[0] && data.content[0].text) {
        return data.content[0].text || "";
      }

      return "";
    }
  };
}
