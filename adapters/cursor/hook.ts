#!/usr/bin/env node
/**
 * Dev-Mem Cursor adapter hook handler.
 *
 * Installed as: .cursor/hooks/dev-mem-<event>.js
 * Invoked by:  Cursor CLI (cursor-agent) on each lifecycle event
 * Protocol:   JSON via stdin → JSON via stdout
 *
 * Differences from codex/hook.ts:
 *   - agent label is "cursor"
 *   - Events are camelCase ("sessionStart", "preToolUse", "postToolUse", "stop")
 *   - SessionEnd is omitted because it is unreliable in CLI mode.
 *   - Implements the §7.2 N-accumulated-events checkpoint trigger for batched
 *     LLM extraction on `stop` to compensate for the missing SessionEnd.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeterministicCapture } from "../../core/capture/index.js";
import { EventLog } from "../../core/capture/log.js";
import { getExtractionEventThreshold } from "../../core/checkpoint.js";
import { numberFor, parseHookPayload, recordFor, stringFor } from "../../core/hook-safety.js";
import type { CursorHookInput } from "./types.js";

function parseInput(): CursorHookInput | null {
  try {
    const inputStr = readFileSync(0, "utf-8");
    if (!inputStr) return null;
    return parseHookPayload(inputStr, ["sessionStart", "preToolUse", "postToolUse", "stop"], "cursor") as CursorHookInput | null;
  } catch (error) {
    console.error(`[dev-mem/cursor] Ignoring unreadable hook input: ${(error as Error).message}`);
    return null;
  }
}

async function triggerExtractionIfThresholdMet(projectRoot: string, sessionId: string) {
  try {
    const log = new EventLog({ persistPath: join(projectRoot, ".dev-mem", "events.jsonl") });
    if (!log.getEvents().some((event) => event.session_id === sessionId && event.type === "session_start")) {
      console.error(`[dev-mem/cursor] Skipping checkpoint without a prior SessionStart for ${sessionId}`);
      return;
    }
    const events = log.getEvents().filter(e => e.session_id === sessionId && e.type === "tool_call" && (e as any).exit_code !== -1);
    const threshold = getExtractionEventThreshold(projectRoot);

    // If we just hit a multiple of N (and N > 0), trigger the extraction spawn
    if (events.length > 0 && events.length % threshold === 0) {
      const cp = await import("node:child_process");
      const path = await import("node:path");
      const url = await import("node:url");
      const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
      const cliPath = path.join(currentDir, "../../cli/index.js");

      const child = cp.spawn("node", [cliPath, "extract", sessionId], {
        cwd: projectRoot,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
  } catch (err) {
    console.error(`[dev-mem/cursor] Checkpoint trigger skipped: ${(err as Error).message}`);
  }
}

async function main() {
  const payload = parseInput();
  if (!payload) {
    process.exit(0);
  }

  try {
    const projectRoot = payload.cwd || process.cwd();
    const capture = new DeterministicCapture({ projectRoot, agent: "cursor", sessionId: payload.session_id });
    switch (payload.hook_event_name) {
      // ─── Session lifecycle ───────────────────────────────────────────────

      case "sessionStart": {
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

        const nodes = retrieveContext({ projectRoot, currentFiles });
        const contextBlock = generateInjectionString(nodes);

        const additionalContext = [regressionWarning, contextBlock]
          .filter(Boolean)
          .join("\\n\\n");

        if (additionalContext) {
          console.log(JSON.stringify({
            hookSpecificOutput: { additionalContext }
          }));
        }
        break;
      }

      // ─── Tool-call recording ─────────────────────────────────────────────

      case "preToolUse": {
        const toolName = stringFor(payload.tool_name);
        const toolInput = recordFor(payload.tool_input);

        let command = toolName;
        let args: string[] = [];
        let touchedFile: string | undefined;

        if (toolName === "Bash" || toolName === "Terminal") {
          command = stringFor(toolInput.command, toolName);
          args = [];
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

        capture.recordToolCall({
          command,
          args,
          exit_code: -1,   // pre-execution sentinel
        });

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

      case "postToolUse": {
        const toolName = stringFor(payload.tool_name);
        const toolInput = recordFor(payload.tool_input);
        const toolResponse = recordFor(payload.tool_response);

        let command = toolName;
        let args: string[] = [];
        let stdout: string | undefined;
        let stderr: string | undefined;
        let exitCode = 0;
        let touchedFile: string | undefined;

        if (toolName === "Bash" || toolName === "Terminal") {
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

        // We can trigger extraction here, but "stop" is often a better turn boundary.
        break;
      }

      case "stop": {
        capture.captureGit();
        
        // Spec §7.2: N-accumulated-events checkpoint trigger for batched extraction.
        // We use 'stop' (end of turn) as the ideal place to evaluate the checkpoint.
        await triggerExtractionIfThresholdMet(projectRoot, payload.session_id);
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("[Dev-Mem/Cursor] Hook error:", err);
  }

  process.exit(0);
}

main();
