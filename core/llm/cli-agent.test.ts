import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildCliCommandSpec,
  createCliAgentProvider,
  detectAvailableCliAgents,
  mapSessionAgentToCli,
  resolveWindowsCliInvocation,
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
    expect(mapSessionAgentToCli("antigravity")).toBe("agy");
    expect(mapSessionAgentToCli("agy")).toBe("agy");
    expect(mapSessionAgentToCli("antigravity-cli")).toBe("agy");
    expect(mapSessionAgentToCli("gemini")).toBe("agy");
    expect(mapSessionAgentToCli("gemini-cli")).toBe("agy");
    expect(mapSessionAgentToCli("cursor")).toBeNull();
  });

  it("builds non-interactive CLI invocations for claude, codex, and agy", () => {
    const claudeSpec = buildCliCommandSpec("claude");
    expect(claudeSpec.command).toBe("claude");
    expect(claudeSpec.args).toContain("-p");
    expect(claudeSpec.args).toContain("--no-session-persistence");

    const codexSpec = buildCliCommandSpec("codex", "gpt-5-mini");
    expect(codexSpec.command).toBe("codex");
    expect(codexSpec.args).toEqual(["exec", "-m", "gpt-5-mini", "-"]);

    const agyDefaultSpec = buildCliCommandSpec("agy");
    expect(agyDefaultSpec.command).toBe("agy");
    expect(agyDefaultSpec.args).toEqual(["-p", "Read instructions and input from stdin and respond directly."]);
    expect(agyDefaultSpec.args).not.toContain("--model");
    expect(agyDefaultSpec.args).not.toContain("--output-format");
    expect(agyDefaultSpec.args).not.toContain("--tools");

    const agyModelSpec = buildCliCommandSpec("agy", "gemini-3-flash");
    expect(agyModelSpec.command).toBe("agy");
    expect(agyModelSpec.args[0]).toBe("--model");
    expect(agyModelSpec.args[1]).toBe("gemini-3-flash");
    expect(agyModelSpec.args[2]).toBe("-p");
    expect(agyModelSpec.args.length).toBe(4);
    expect(agyModelSpec.args).not.toContain("--output-format");
    expect(agyModelSpec.args).not.toContain("--tools");
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
    expect(spawnCall!.options.shell).toBe(false);
    expect(spawnCall!.options.env.DEV_MEM_DISABLE_HOOKS).toBe("1");
    expect(stdinGetter()).toContain("SYSTEM PROMPT");
    expect(stdinGetter()).toContain("USER PROMPT");
  });

  it("resolves Windows executables with shell=false for .exe and shell=true only for .cmd/.bat shims", () => {
    expect(resolveWindowsCliInvocation("agy", "C:\\Program Files\\Antigravity\\agy.exe\r\n")).toEqual({
      command: "C:\\Program Files\\Antigravity\\agy.exe",
      shell: false,
    });
    expect(
      resolveWindowsCliInvocation(
        "claude",
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd\r\n",
      ),
    ).toEqual({
      command: "claude",
      shell: true,
    });
    expect(resolveWindowsCliInvocation("codex", "C:\\tools\\codex.bat\r\n")).toEqual({
      command: "codex",
      shell: true,
    });
    expect(resolveWindowsCliInvocation("agy", "")).toEqual({
      command: "agy",
      shell: false,
    });
  });

  it("throws a clear error when the CLI exits non-zero", async () => {
    const provider = createCliAgentProvider("codex", {
      spawnFn: (() => createFakeChild(1, "", "Not logged in").child) as any,
    });

    await expect(provider.complete("sys", "usr", 100)).rejects.toThrow(/CLI codex exited with code 1.*Not logged in/);
  });

  it("detectAvailableCliAgents returns only binaries resolved successfully", () => {
    const detected = detectAvailableCliAgents((bin) => bin === "claude" || bin === "agy");
    expect(detected).toEqual(["claude", "agy"]);
  });
});
