import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildCliCommandSpec,
  createCliAgentProvider,
  detectAvailableCliAgents,
  mapSessionAgentToCli,
} from "./cli-agent.js";

function createFakeChild(exitCode: number, stdoutData: string, stderrData = "") {
  const child = new EventEmitter() as any;
  const stdinStream = new PassThrough();
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  let capturedStdin = "";
  stdinStream.on("data", (chunk) => {
    capturedStdin += chunk.toString();
  });

  child.stdin = stdinStream;
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (stdoutData) stdoutStream.write(stdoutData);
    if (stderrData) stderrStream.write(stderrData);
    stdoutStream.end();
    stderrStream.end();
    child.emit("close", exitCode);
  });

  return { child, getCapturedStdin: () => capturedStdin };
}

describe("Zero-API-key host CLI LLM provider", () => {
  it("maps session agent names to host CLI kinds", () => {
    expect(mapSessionAgentToCli("claude-code")).toBe("claude");
    expect(mapSessionAgentToCli("codex")).toBe("codex");
    expect(mapSessionAgentToCli("gemini")).toBe("gemini");
    expect(mapSessionAgentToCli("cursor")).toBeNull();
  });

  it("builds non-interactive CLI invocations for claude, codex, and gemini", () => {
    const claudeSpec = buildCliCommandSpec("claude");
    expect(claudeSpec.command).toBe("claude");
    expect(claudeSpec.args).toContain("-p");
    expect(claudeSpec.args).toContain("--no-session-persistence");

    const codexSpec = buildCliCommandSpec("codex", "gpt-5-mini");
    expect(codexSpec.command).toBe("codex");
    expect(codexSpec.args).toEqual(["exec", "-m", "gpt-5-mini", "-"]);

    const geminiSpec = buildCliCommandSpec("gemini");
    expect(geminiSpec.command).toBe("gemini");
    expect(geminiSpec.args).toContain("-p");
  });

  it("spawns in os.tmpdir() with DEV_MEM_DISABLE_HOOKS=1 and pipes prompt via stdin", async () => {
    let spawnCall: { command: string; args: string[]; options: any } | null = null;
    let stdinGetter = () => "";

    const provider = createCliAgentProvider("claude", {
      spawnFn: ((command: string, args: string[], options: any) => {
        spawnCall = { command, args, options };
        const fake = createFakeChild(0, '{"nodes": []}');
        stdinGetter = fake.getCapturedStdin;
        return fake.child;
      }) as any,
    });

    expect(provider.name).toBe("cli-claude");
    const out = await provider.complete("SYSTEM PROMPT", "USER PROMPT", 1024);
    expect(out).toBe('{"nodes": []}');

    expect(spawnCall).not.toBeNull();
    expect(spawnCall!.options.cwd).toBe(tmpdir());
    expect(spawnCall!.options.env.DEV_MEM_DISABLE_HOOKS).toBe("1");
    expect(stdinGetter()).toContain("SYSTEM PROMPT");
    expect(stdinGetter()).toContain("USER PROMPT");
  });

  it("throws a clear error when the CLI exits non-zero", async () => {
    const provider = createCliAgentProvider("codex", {
      spawnFn: (() => createFakeChild(1, "", "Not logged in").child) as any,
    });

    await expect(provider.complete("sys", "usr", 100)).rejects.toThrow(/CLI codex exited with code 1.*Not logged in/);
  });

  it("detectAvailableCliAgents returns only binaries resolved successfully", () => {
    const detected = detectAvailableCliAgents((bin) => bin === "claude" || bin === "gemini");
    expect(detected).toEqual(["claude", "gemini"]);
  });
});
