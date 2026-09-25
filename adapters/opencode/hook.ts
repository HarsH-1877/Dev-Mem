#!/usr/bin/env node
/**
 * Dev-Mem OpenCode adapter hook handler.
 *
 * Invoked by: OpenCode plugin (.opencode/plugins/dev-mem.ts)
 * Protocol: JSON via stdin → JSON via stdout
 *
 * Implements the provider-neutral interface against OpenCode's actual lifecycle:
 * - SessionStart = chat.message (where context is injected into parts)
 * - PostToolUse = tool.execute.after
 * - SessionEnd = session.idle event (turn-based extraction checkpoint)
 */
import { readFileSync } from "node:fs";
import { DeterministicCapture } from "../../core/capture/index.js";
import { parseHookPayload, stringFor, numberFor } from "../../core/hook-safety.js";
import type { OpenCodeHookInput } from "./types.js";

function parseInput(): OpenCodeHookInput | null {
  try {
    const inputStr = readFileSync(0, "utf-8");
    if (!inputStr) return null;
    return parseHookPayload(inputStr, ["chat.message", "tool.execute.after", "session.idle"], "opencode") as OpenCodeHookInput | null;
  } catch (error) {
    console.error(`[dev-mem/opencode] Ignoring unreadable hook input: ${(error as Error).message}`);
    return null;
  }
}

async function triggerExtraction(projectRoot: string, sessionId: string) {
  try {
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
  } catch (err) {
    console.error(`[dev-mem/opencode] Extraction trigger skipped: ${(err as Error).message}`);
  }
}

async function main() {
  const payload = parseInput();
  if (!payload) {
    process.exit(0);
  }

  try {
    const projectRoot = payload.cwd || process.cwd();
    const capture = new DeterministicCapture({ projectRoot, agent: "opencode", sessionId: payload.session_id });
    
    switch (payload.hook_event_name) {
      case "chat.message": {
        // OpenCode triggers this on every prompt. We treat the first one as SessionStart.
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
          .join("\n\n");

        if (additionalContext) {
          console.log(JSON.stringify({
            hookSpecificOutput: { additionalContext }
          }));
        }
        break;
      }

      case "tool.execute.after": {
        const toolName = stringFor(payload.tool);
        let command = toolName;
        let args: string[] = [];
        let stdout: string | undefined;
        let stderr: string | undefined;
        let exitCode = 0;
        let touchedFile: string | undefined;

        // OpenCode native tools mapping
        if (toolName === "bash") {
          command = "bash";
          args = payload.args?.command ? [payload.args.command] : [];
          stdout = stringFor(payload.output);
          exitCode = payload.metadata?.exit ? numberFor(payload.metadata.exit) : 0;
        } else if (toolName === "write" || toolName === "edit") {
          command = toolName;
          const filePath = stringFor(payload.args?.path, "");
          args = [filePath];
          touchedFile = filePath || undefined;
          stdout = stringFor(payload.output);
        } else {
          command = toolName;
          args = [JSON.stringify(payload.args || {})];
          stdout = stringFor(payload.output);
        }

        capture.recordToolCall({ command, args, exit_code: exitCode, stdout, stderr });

        if (touchedFile && (toolName === "write" || toolName === "edit")) {
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

      case "session.idle": {
        capture.captureGit();
        
        // OpenCode does not have a reliable process-exit hook because it's a long-running CLI/server.
        // Instead, we use the session.status transition to 'idle' (turn completion) as the perfect checkpoint boundary.
        // We trigger batched extraction in a detached process to avoid blocking the agent.
        await triggerExtraction(projectRoot, payload.session_id);
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("[dev-mem/opencode] Hook error:", err);
  }

  process.exit(0);
}

main();
