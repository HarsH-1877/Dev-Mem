// core/llm/openai.ts
import type { LlmProvider } from "./types.js";

// Reverted to original working API URL prefix to avoid 404/405 errors
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
      let currentResponse: Response | null = null;
      const maxRetries = 4;

      // Refactored to standard for-loop syntax instead of Array.of(...)
      for (let i = 0; i < maxRetries; i++) {
        try {
          const res = await fetch(url, {
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
        throw new Error("OpenAI API invocation broke down: No response captured.");
      }

      if (!currentResponse.ok) {
        const errBody = await currentResponse.text();
        const label = isCompatible ? "OpenAI-compatible" : "OpenAI";
        throw new Error(`${label} API error (${currentResponse.status}): ${errBody}`);
      }

      const data = (await currentResponse.json()) as any;
      
      // Retained the clean optional chaining format exactly as requested by mentor
      if (data?.choices?.[0]?.message) {
        return data.choices[0].message.content || "";
      }
      
      return "";
    }
  };
}
