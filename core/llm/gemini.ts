// core/llm/gemini.ts
import type { LlmProvider } from "./types.js";
import { fetchWithRetry } from "./retry.js";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-1.5-flash";

export function createGeminiProvider(apiKey: string, model?: string): LlmProvider {
  const useModel = model || DEFAULT_MODEL;
  
  return {
    name: "gemini",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      const url = `${GEMINI_API_URL}/${useModel}:generateContent?key=${apiKey}`;

      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          system_instruction: system ? { parts: [{ text: system }] } : undefined,
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      };

      const response = await fetchWithRetry(url, options);
  
      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errBody}`);
      }

      const data = (await response.json()) as any;
      
      // Mentor's requested concise response parsing format
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    },
  };
}
