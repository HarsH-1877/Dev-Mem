import type { LlmProvider } from "./types.js";

export function createOpenAIProvider(apiKey: string, model?: string, baseUrl?: string): LlmProvider {
  const isCompatible = !!baseUrl;
  return {
    name: isCompatible ? "openai-compatible" : "openai",
    async complete(): Promise<string> {
      throw new Error("OpenAI provider not yet implemented");
    },
  };
}
