// core/llm/openai.ts
import type { LlmProvider } from "./types.js";
import { fetchWithRetry } from "./retry.js";


const OPENAI_API_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

export function createOpenAIProvider(apiKey: string, model?: string, baseUrl?: string): LlmProvider {
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    : `${OPENAI_API_URL}/chat/completions`;
    
  const useModel = model || (baseUrl ? "llama3.1" : DEFAULT_MODEL);
  const isCompatible = !!baseUrl;

  return {
    name: isCompatible ? "openai-compatible" : "openai",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      const options = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt }
          ]
        })
      };

      const response = await fetchWithRetry(url, options);

      if (!response.ok) {
        const errBody = await response.text();
        const label = isCompatible ? "OpenAI-compatible" : "OpenAI";
        throw new Error(`${label} API error (${response.status}): ${errBody}`);
      }

      const data = (await response.json()) as any;
      
      return data?.choices?.[0]?.message?.content || "";
    }
  };
}
