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
