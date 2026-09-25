// core/llm/gemini.ts
import type { LlmProvider } from "./types.js";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.0-flash";

/**
 * Google Gemini provider.
 * Uses the Gemini generateContent REST API with an API key.
 * Supports GEMINI_API_KEY or GOOGLE_API_KEY env vars (resolution handled by caller).
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
