import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProvider, resolveProviderForProject } from "./index.js";
import { createOpenAIProvider } from "./openai.js";
import { createGeminiProvider } from "./gemini.js";

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

describe("Gemini Provider", () => {
  it("creates a provider with the correct name", () => {
    const provider = createGeminiProvider("test-key");
    expect(provider.name).toBe("gemini");
  });

  it("has a complete method", () => {
    const provider = createGeminiProvider("test-key");
    expect(typeof provider.complete).toBe("function");
  });
});

describe("Config-based provider resolution", () => {
  it("reads llm_provider and llm_base_url from .dev-mem/config.yml", () => {
    const cwd = mkdtempSync(join(tmpdir(), "dev-mem-llm-cfg-"));
    try {
      mkdirSync(join(cwd, ".dev-mem"));
      writeFileSync(join(cwd, ".dev-mem", "config.yml"),
        "llm_provider: openai-compatible\nllm_base_url: http://localhost:11434/v1\n"
      );

      const provider = resolveProviderForProject(cwd);
      expect(provider).not.toBeNull();
      expect(provider!.name).toBe("openai-compatible");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

