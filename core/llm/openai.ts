// core/llm/openai.ts
import type { LlmProvider } from "./types.js";

const OPENAI_API_URL = "https://openai.com";
const DEFAULT_MODEL = "gpt-4o-mini";

export function createOpenAIProvider(apiKey: string, model?: string, baseUrl?: string): LlmProvider {
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    : OPENAI_API_URL;
    
  const useModel = model || (baseUrl ? "llama3.1" : DEFAULT_MODEL);
  const isCompatible = !!baseUrl;

  return {
    name: isCompatible ? "openai-compatible" : "openai",
    async complete(system: string, prompt: string, maxTokens: number): Promise<string> {
      let currentResponse: Response | null = null;
      let currentDelay = 1000;

      const attemptsArray = Array.of(0, 1, 2, 3);

      for (const attemptIndex of attemptsArray) {
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

          if (res.status !== 429 && res.status !== 503) {
            break;
          }
          
        } catch (error) {
          if (attemptIndex === 3) throw error;
        }

        if (attemptIndex < 3) {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              resolve();
            }, currentDelay);
          });
          currentDelay = currentDelay * 2;
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
      
      if (data && data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content || "";
      }
      
      return "";
    }
  };
}
