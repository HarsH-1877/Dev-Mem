// core/llm/anthropic.ts
import type { LlmProvider } from "./types.js";
import { fetchWithRetry } from "./retry.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

export function createAnthropicProvider(apiKey: string, model?: string): LlmProvider {
  const useModel = model || DEFAULT_MODEL;

  return {
    name: "anthropic",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: maxTokens,
          system: system || undefined,
          messages: [
            { role: "user", content: prompt }
          ]
        })
      };

     const response = await fetchWithRetry(ANTHROPIC_API_URL, options);


      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errBody}`);
      }

      const data = (await response.json()) as any;

      // Mentor's requested original .find() array text block filter behavior
      return data?.content?.find((c: any) => c.type === "text")?.text || "";
    }
  };
}
