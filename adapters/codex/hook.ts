#!/usr/bin/env node
/**
 * Dev-Mem Codex adapter hook handler.
 *
 * Installed as: .codex/hooks/dev-mem-<event>.js
 * Invoked by:  Codex CLI on each registered lifecycle event
 * Protocol:   JSON via stdin → JSON via stdout (identical to Claude Code)
 *
 * Differences from claude-code/hook.ts:
 *   - agent label is "codex" (written to evidence.agent)
 *   - SessionEnd uses the detached-spawn pattern because Codex's SessionEnd
 *     timeout is strictly 1-3 seconds synchronously (the async flag in
 *     hooks.json is ignored for SessionEnd).
 *   - PreToolUse events are forwarded to capture. We record them as tool_call
 *     events with exit_code -1 (pre-execution, outcome unknown) to build a
 *     richer session log.
 */
import { readFileSync } from "node:fs";
import { DeterministicCapture } from "../../core/capture/index.js";
import { numberFor, parseHookPayload, recordFor, stringFor } from "../../core/hook-safety.js";
import type { CodexHookInput } from "./types.js";

function parseInput(): CodexHookInput | null {
  try {
    const inputStr = readFileSync(0, "utf-8");
    if (!inputStr) return null;
    return parseHookPayload(inputStr, ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"], "codex") as CodexHookInput | null;
  } catch (error) {
    console.error(`[dev-mem/codex] Ignoring unreadable hook input: ${(error as Error).message}`);
    return null;
  }
}

async function main() {
  const payload = parseInput();
  if (!payload) {
    process.exit(0);
  }

  try {
    const projectRoot = payload.cwd || process.cwd();
    const capture = new DeterministicCapture({ projectRoot, agent: "codex", sessionId: payload.session_id });
    switch (payload.hook_event_name) {
      // ─── Session lifecycle ───────────────────────────────────────────────

      case "SessionStart": {
        capture.startSession();
        const gitSnap = capture.captureGit();

        const { retrieveContext, generateInjectionString } = await import("../../core/retrieval/index.js");
        const { checkRegressionRisk, formatRegressionWarning } = await import("../../core/regression/index.js");

        const currentFiles = Array.isArray(gitSnap.status)
          ? gitSnap.status.map((s) => s.path)
          : [];

        const regressionMatches = checkRegressionRisk({
          projectRoot,
          currentFiles,
          confidenceThreshold: 0.6,
        });
        const regressionWarning = formatRegressionWarning(regressionMatches);

        // Adaptive-budget retrieval — same default as Claude Code adapter.
        const nodes = retrieveContext({ projectRoot, currentFiles });
        const contextBlock = generateInjectionString(nodes);

        const additionalContext = [regressionWarning, contextBlock]
          .filter(Boolean)
          .join("\n\n");

        if (additionalContext) {
          console.log(JSON.stringify({
            hookSpecificOutput: { additionalContext }
          }));
        }
        break;
      }

      // ─── Tool-call recording ─────────────────────────────────────────────

      case "PreToolUse": {
        // Codex-only: fires BEFORE a tool executes. Record with exit_code -1
        // (outcome unknown at this point) so the session log has full lineage.
        const toolName = stringFor(payload.tool_name);
        const toolInput = recordFor(payload.tool_input);

        let command = toolName;
        let args: string[] = [];
        let touchedFile: string | undefined;

        if (toolName === "Bash") {
          command = stringFor(toolInput.command, toolName);
          args = [];
        } else if (
          toolName === "Write" ||
          toolName === "Edit" ||
          toolName === "Read" ||
          toolName === "str_replace_editor"
        ) {
          command = toolName;
          const filePath = stringFor(toolInput.file_path, stringFor(toolInput.path, ""));
          args = [filePath];
          touchedFile = filePath || undefined;
        } else {
          command = toolName;
          args = [JSON.stringify(toolInput)];
        }

        capture.recordToolCall({
          command,
          args,
          exit_code: -1,   // pre-execution sentinel
        });

        // §8.1 Pre-execution regression check — PreToolUse is the earliest
        // moment we know exactly which file is about to be changed.
        if (touchedFile && (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor")) {
          const { checkRegressionRisk, formatRegressionWarning } = await import("../../core/regression/index.js");
          const matches = checkRegressionRisk({
            projectRoot,
            currentFiles: [touchedFile],
            confidenceThreshold: 0.6,
          });
          const warning = formatRegressionWarning(matches);
          if (warning) {
            // On PreToolUse, we can *block* or inject context.
            // We inject context (don't block) — same policy as Claude Code.
            console.log(JSON.stringify({
              hookSpecificOutput: { additionalContext: warning }
            }));
          }
        }
        break;
      }

      case "PostToolUse": {
        const toolName = stringFor(payload.tool_name);
        const toolInput = recordFor(payload.tool_input);
        const toolResponse = recordFor(payload.tool_response);

        let command = toolName;
        let args: string[] = [];
        let stdout: string | undefined;
        let stderr: string | undefined;
        let exitCode = 0;
        let touchedFile: string | undefined;

        if (toolName === "Bash") {
          command = stringFor(toolInput.command, toolName);
          stdout = typeof toolResponse.output === "string" ? toolResponse.output : typeof toolResponse.stdout === "string" ? toolResponse.stdout : undefined;
          stderr = typeof toolResponse.stderr === "string" ? toolResponse.stderr : undefined;
          exitCode = numberFor(toolResponse.exit_code);
        } else if (
          toolName === "Write" ||
          toolName === "Edit" ||
          toolName === "str_replace_editor"
        ) {
          command = toolName;
          const filePath = stringFor(toolInput.file_path, stringFor(toolInput.path, ""));
          args = [filePath];
          touchedFile = filePath || undefined;
        } else {
          command = toolName;
          args = [JSON.stringify(toolInput)];
        }

        capture.recordToolCall({ command, args, exit_code: exitCode, stdout, stderr });

        // §8.1 Post-execution regression check for file-touching tools.
        if (touchedFile && (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor")) {
          const { checkRegressionRisk, formatRegressionWarning } = await import("../../core/regression/index.js");
          const matches = checkRegressionRisk({
            projectRoot,
            currentFiles: [touchedFile],
            confidenceThreshold: 0.6,
          });
          const warning = formatRegressionWarning(matches);
          if (warning) {
            console.log(JSON.stringify({
              hookSpecificOutput: { additionalContext: warning }
            }));
          }
        }
        break;
      }

      case "Stop":
        capture.captureGit();
        break;

      case "SessionEnd": {
        capture.endSession();
        if (!capture.getEvents().some((event) => event.session_id === payload.session_id && event.type === "session_start")) {
          console.error(`[dev-mem/codex] Ignoring SessionEnd without a prior SessionStart for ${payload.session_id}`);
          break;
        }
        // Detached spawn ensures extraction survives Codex's 1-3s synchronous timeout
        const cp = await import("node:child_process");
        const path = await import("node:path");
        const url = await import("node:url");
        const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
        const cliPath = path.join(currentDir, "../../cli/index.js");

        const child = cp.spawn("node", [cliPath, "extract", payload.session_id], {
          cwd: projectRoot,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("[Dev-Mem/Codex] Hook error:", err);
  }

  process.exit(0);
}

main();
