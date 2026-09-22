#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { DeterministicCapture } from "../../core/capture/index.js";
import { parseHookPayload, recordFor, stringFor } from "../../core/hook-safety.js";
import type { ClaudeCodeHookInput } from "./types.js";

function parseInput(): ClaudeCodeHookInput | null {
  try {
    const inputStr = readFileSync(0, "utf-8");
    if (!inputStr) return null;
    return parseHookPayload(inputStr, ["SessionStart", "PostToolUse", "Stop", "SessionEnd"], "claude-code") as ClaudeCodeHookInput | null;
  } catch (e) {
    console.error(`[dev-mem/claude-code] Ignoring unreadable hook input: ${(e as Error).message}`);
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
    const capture = new DeterministicCapture({ projectRoot, agent: "claude-code", sessionId: payload.session_id });
    switch (payload.hook_event_name) {
      case "SessionStart": {
        capture.startSession();
        const gitSnap = capture.captureGit();

        const { retrieveContext, generateInjectionString } = await import("../../core/retrieval/index.js");
        const { checkRegressionRisk, formatRegressionWarning } = await import("../../core/regression/index.js");

        // Files currently modified/staged in working tree (if any)
        const currentFiles = Array.isArray(gitSnap.status) ? gitSnap.status.map((s) => s.path) : [];

        // session_title is the closest available task-description signal from
        // Claude Code's SessionStart payload — used to improve relevance scoring.
        const sessionStartPayload = payload as import("./types.js").SessionStartInput;
        const currentTask = sessionStartPayload.session_title ?? undefined;

        const regressionMatches = checkRegressionRisk({
          projectRoot,
          currentFiles,
          confidenceThreshold: 0.6,
        });
        const regressionWarning = formatRegressionWarning(regressionMatches);

        // Normal ranked retrieval — passes currentTask for relevance scoring
        // when available, falls back to file-overlap when absent.
        // Budget is omitted intentionally: retrieveContext applies an adaptive
        // default (nodeCount × 18, clamped 80–2000) that creates real selection
        // pressure at any graph size without over-injecting on small graphs.
        const nodes = retrieveContext({ projectRoot, currentFiles, currentTask });
        const contextBlock = generateInjectionString(nodes);

        // Regression warning appears first — it is the most actionable signal
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

      case "PostToolUse": {
        const toolName = stringFor(payload.tool_name);
        const toolInput = recordFor(payload.tool_input);
        const toolResponse = recordFor(payload.tool_response);

        let command = toolName;
        let args: string[] = [];
        let exitCode = 0;
        let stdout: string | undefined;
        let stderr: string | undefined;
        let touchedFile: string | undefined;

        if (toolName === "Bash" || toolName === "PowerShell") {
          command = stringFor(toolInput.command, toolName);
          stdout = typeof toolResponse.stdout === "string" ? toolResponse.stdout : undefined;
          stderr = typeof toolResponse.stderr === "string" ? toolResponse.stderr : undefined;
        } else if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
          command = toolName;
          const filePath = stringFor(toolInput.file_path, "");
          args = [filePath];
          touchedFile = filePath || undefined;
        } else {
          command = toolName;
          args = [JSON.stringify(toolInput)];
        }

        capture.recordToolCall({
          command,
          args,
          exit_code: exitCode,
          stdout,
          stderr,
        });

        // §8.1 Mid-session regression check: fires when agent writes/edits a
        // file, which is the precise moment we know the exact file being changed.
        // PostToolUse gives us the file name; SessionStart does not.
        if (touchedFile && (toolName === "Write" || toolName === "Edit")) {
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
          console.error(`[dev-mem/claude-code] Ignoring SessionEnd without a prior SessionStart for ${payload.session_id}`);
          break;
        }
        // Detached spawn to avoid the 1.5s hook timeout (M4 fix)
        const cp = await import("node:child_process");
        const path = await import("node:path");
        const url = await import("node:url");
        const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
        const cliPath = path.join(currentDir, "../../cli/index.js");

        const child = cp.spawn("node", [cliPath, "extract", payload.session_id], {
          cwd: projectRoot,
          detached: true,
          stdio: "ignore"
        });
        child.unref();
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("[Dev-Mem] Hook error:", err);
  }

  process.exit(0);
}

main();
