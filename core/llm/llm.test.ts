import { describe, expect, it } from "vitest";
import { resolveProvider } from "./index.js";
import { createOpenAIProvider } from "./openai.js";

describe("LLM Provider Resolution", () => {
  it("returns null when no API keys are available", () => {
    const saved = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.DEV_MEM_LLM_BASE_URL;
    delete process.env.DEV_MEM_LLM_PROVIDER;
    delete process.env.DEV_MEM_LLM_API_KEY;
    
    const provider = resolveProvider();
    expect(provider).toBeNull();

    Object.assign(process.env, saved);
  });

  it("resolves Anthropic provider when provider=anthropic and apiKey given", () => {
    const provider = resolveProvider({ apiKey: "test-key", provider: "anthropic" });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("anthropic");
  });

  it("resolves OpenAI provider when provider=openai and apiKey given", () => {
    const provider = resolveProvider({ apiKey: "test-key", provider: "openai" });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("openai");
  });

  it("resolves OpenAI-compatible provider when base URL is passed", () => {
    const provider = resolveProvider({ apiKey: "ollama", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1" });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("openai-compatible");
  });

  it("resolves Gemini provider when provider=gemini and apiKey given", () => {
    const provider = resolveProvider({ apiKey: "test-key", provider: "gemini" });
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("gemini");
  });
});

describe("OpenAI Provider", () => {
  it("creates a provider with the correct name", () => {
    const provider = createOpenAIProvider("test-key");
    expect(provider.name).toBe("openai");
  });

  it("creates an openai-compatible provider when baseUrl is given", () => {
    const provider = createOpenAIProvider("ollama", undefined, "http://localhost:11434/v1");
    expect(provider.name).toBe("openai-compatible");
  });

  it("has a complete method", () => {
    const provider = createOpenAIProvider("test-key");
    expect(typeof provider.complete).toBe("function");
  });
});

