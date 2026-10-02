// core/llm/gemini.ts
import type { LlmProvider } from "./types.js";

// FIXED: Correct Google Gemini base path endpoint
const GEMINI_API_URL = "https://googleapis.com";
const DEFAULT_MODEL = "gemini-1.5-flash";

export function createGeminiProvider(apiKey: string, model?: string): LlmProvider {
  const useModel = model || DEFAULT_MODEL;
  
  return {
    name: "gemini",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      const url = `${GEMINI_API_URL}/${useModel}:generateContent?key=${apiKey}`;

      let response: Response | null = null;
      let delay = 1000; 

      for (let i = 0; i < 4; i++) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: system ? `${system}\n\n${prompt}` : prompt }] }],
              generationConfig: { maxOutputTokens: maxTokens },
            }),
          });

          response = res;

          if (res.ok) {
            break;
          }

          if (res.status !== 429 && res.status !== 503) {
            break;
          }
        } catch (error) {
          if (i === 3) throw error;
        }

        if (i < 3) {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              resolve();
            }, delay);
          });
          delay *= 2;
        }
      }

      // FIXED BUG: Changed global 'Response' to lowercase variable 'response'
      if (!response) {
        throw new Error("Gemini API invocation broke down: No response captured from loop workflow.");
      }
  
      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errBody}`);
      }

      const data = (await response.json()) as any;
      
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    },
  };
}
