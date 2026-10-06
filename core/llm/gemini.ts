// core/llm/gemini.ts
import type { LlmProvider } from "./types.js";

// FIXED: Reverted to the correct official Google Gemini REST base endpoint path
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// Restored the proper default model as requested by the mentor
const DEFAULT_MODEL = "gemini-2.0-flash";

export function createGeminiProvider(apiKey: string, model?: string): LlmProvider {
  const useModel = model || DEFAULT_MODEL;
  
  return {
    name: "gemini",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      const url = `${GEMINI_API_URL}/${useModel}:generateContent?key=${apiKey}`;

      let currentResponse: Response | null = null;
      const maxRetries = 4;

      // Refactored to standard for-loop syntax instead of Array.of(...)
      for (let i = 0; i < maxRetries; i++) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              // Restored the native system_instruction parameter object exactly as requested by mentor
              system_instruction: system ? { parts: [{ text: system }] } : undefined,
              generationConfig: { maxOutputTokens: maxTokens },
            }),
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

        // Apply exponential backoff with randomized jitter to prevent thundering herds
        if (i < maxRetries - 1) {
          const jitterDelay = Math.pow(2, i) * 1000 + Math.random() * 1000;
          await new Promise<void>((resolve) => setTimeout(resolve, jitterDelay));
        }
      }

      if (!currentResponse) {
        throw new Error("Gemini API invocation broke down: No response captured from loop workflow.");
      }
  
      if (!currentResponse.ok) {
        const errBody = await currentResponse.text();
        throw new Error(`Gemini API error (${currentResponse.status}): ${errBody}`);
      }

      const data = (await currentResponse.json()) as any;
      
      // Fixed syntax mapping for candidates content array structure safely
      if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
        return data.candidates[0].content.parts[0].text || "";
      }
      
      return "";
    },
  };
}
