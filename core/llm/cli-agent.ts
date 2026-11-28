import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { LlmProvider } from "./types.js";

export type CliAgentKind = "claude" | "codex" | "gemini";

export const CLI_AGENT_KINDS: readonly CliAgentKind[] = ["claude", "codex", "gemini"];

export interface CliCommandSpec {
  command: CliAgentKind;
  args: string[];
}

export interface CliAgentProviderOptions {
  model?: string;
  timeoutMs?: number;
  spawnFn?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Maps a session's agent identifier (e.g. "claude-code", "codex", "gemini")
 * to a headless host CLI capable of single-turn completion.
 */
export function mapSessionAgentToCli(sessionAgent?: string): CliAgentKind | null {
  if (!sessionAgent) return null;
  const normalized = sessionAgent.trim().toLowerCase();
  if (normalized === "claude-code" || normalized === "claude") return "claude";
  if (normalized === "codex" || normalized === "codex-cli") return "codex";
  if (normalized === "gemini" || normalized === "gemini-cli") return "gemini";
  return null;
}

/**
 * Checks which host agent CLIs exist on PATH. Accepts an injectable resolver for tests.
 */
export function detectAvailableCliAgents(
  isPresent?: (bin: CliAgentKind) => boolean,
): CliAgentKind[] {
  const check = isPresent ?? defaultCliLookup;
  return CLI_AGENT_KINDS.filter((bin) => check(bin));
}

function defaultCliLookup(bin: CliAgentKind): boolean {
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const res = spawnSync(cmd, [bin], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return res.status === 0 && Boolean(res.stdout?.trim());
  } catch {
    return false;
  }
}

/**
 * Builds constant non-interactive command flags for the given CLI.
 * The full prompt is passed via stdin rather than argv to avoid shell escaping
 * quirks and Windows command-line length limits.
 */
export function buildCliCommandSpec(kind: CliAgentKind, model?: string): CliCommandSpec {
  switch (kind) {
    case "claude": {
      const args = [
        "-p",
        "--model",
        model || "haiku",
        "--output-format",
        "text",
        "--no-session-persistence",
        "--tools",
        "",
      ];
      return { command: "claude", args };
    }
    case "codex": {
      const args = ["exec"];
      if (model) args.push("-m", model);
      args.push("-");
      return { command: "codex", args };
    }
    case "gemini": {
      const args: string[] = [];
      if (model) args.push("-m", model);
      args.push("-p", "Follow the system instructions and extract JSON strictly from the session log on stdin.");
      return { command: "gemini", args };
    }
  }
}

/**
 * LlmProvider backed by the developer's already-authenticated host agent CLI
 * (Claude Code, Codex CLI, or Gemini CLI), requiring no second paid API key.
 */
export function createCliAgentProvider(
  kind: CliAgentKind,
  options: CliAgentProviderOptions = {},
): LlmProvider {
  const spec = buildCliCommandSpec(kind, options.model);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnImpl = options.spawnFn ?? spawn;

  return {
    name: `cli-${kind}`,
    async complete(system: string, prompt: string, _maxTokens: number): Promise<string> {
      const fullPrompt = `${system}\n\n${prompt}`;

      return new Promise<string>((resolve, reject) => {
        let settled = false;
        let stdout = "";
        let stderr = "";

        const child = spawnImpl(spec.command, spec.args, {
          cwd: tmpdir(),
          env: {
            ...process.env,
            DEV_MEM_DISABLE_HOOKS: "1",
          },
          shell: process.platform === "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            child.kill();
          } catch {
            // ignore
          }
          reject(new Error(`CLI ${kind} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();

        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });

        child.on("error", (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Failed to spawn CLI ${kind}: ${err.message}`));
        });

        child.on("close", (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0) {
            const detail = stderr.trim() || stdout.trim() || "unknown error";
            reject(new Error(`CLI ${kind} exited with code ${code}: ${detail}`));
            return;
          }
          resolve(stdout.trim());
        });

        try {
          child.stdin?.write(fullPrompt);
          child.stdin?.end();
        } catch {
          // Wait for close/error handler
        }
      });
    },
  };
}
