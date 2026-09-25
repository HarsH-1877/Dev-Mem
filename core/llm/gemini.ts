import type { LlmProvider } from "./types.js";

export function createGeminiProvider(apiKey: string, model?: string): LlmProvider {
  return {
    name: "gemini",
    async complete(): Promise<string> {
      throw new Error("Gemini provider not yet implemented");
    },
  };
}
