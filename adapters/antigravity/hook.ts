#!/usr/bin/env node
/**
 * Dev-Mem Antigravity adapter hook handler.
 *
 * Installed via: .agents/hooks.json + .agents/hooks/dev-mem-<event>.js
 * Protocol:      camelCase JSON via stdin -> JSON via stdout
 */
import { readFileSync } from "node:fs";
import { DeterministicCapture } from "../../core/capture/index.js";
import { retryPendingExtractions } from "../../core/extraction-retry.js";
import { recordFor, stringFor } from "../../core/hook-safety.js";
import type { AntigravityHookInput } from "./types.js";

const EXPECTED_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] as const;

const FILE_WRITE_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "Write",
  "Edit",
]);

const FILE_READ_TOOLS = new Set(["view_file", "Read"]);

function parseInput(): AntigravityHookInput | null {
  try {
    const inputStr = readFileSync(0, "utf-8");
    if (!inputStr) return null;

    let value: unknown;
    try {
      value = JSON.parse(inputStr);
    } catch (error) {
      console.error(`[dev-mem/antigravity] Ignoring malformed hook JSON: ${(error as Error).message}`);
      return null;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      console.error("[dev-mem/antigravity] Ignoring hook payload: expected an object");
      return null;
    }

    const payload = value as Record<string, unknown>;
    if (typeof payload.conversationId !== "string" || payload.conversationId.trim() === "") {
      console.error("[dev-mem/antigravity] Ignoring hook payload: missing string conversationId");
      return null;
    }
    if (
      typeof payload.hookEventName !== "string" ||
      !(EXPECTED_EVENTS as readonly string[]).includes(payload.hookEventName)
    ) {
      console.error("[dev-mem/antigravity] Ignoring hook payload: unsupported hookEventName");
      return null;
    }
    if (payload.cwd !== undefined && (typeof payload.cwd !== "string" || payload.cwd.trim() === "")) {
      console.error("[dev-mem/antigravity] Ignoring hook payload: cwd must be a non-empty string");
      return null;
    }

    return payload as unknown as AntigravityHookInput;
  } catch (error) {
    console.error(`[dev-mem/antigravity] Ignoring unreadable hook input: ${(error as Error).message}`);
    return null;
  }
}

function extractToolDetails(toolName: string, toolArgs: Record<string, unknown>): {
  command: string;
  args: string[];
  touchedFile?: string;
} {
  if (toolName === "run_command" || toolName === "Bash") {
    const cmd = stringFor(toolArgs.CommandLine, stringFor(toolArgs.command, toolName));
    return { command: cmd, args: [] };
  }

  if (FILE_WRITE_TOOLS.has(toolName) || FILE_READ_TOOLS.has(toolName)) {
    const filePath = stringFor(
      toolArgs.TargetFile,
      stringFor(toolArgs.AbsolutePath, stringFor(toolArgs.file_path, stringFor(toolArgs.path, ""))),
    );
    return {
      command: toolName,
      args: filePath ? [filePath] : [],
      touchedFile: filePath || undefined,
    };
  }

  return {
    command: toolName,
    args: [JSON.stringify(toolArgs)],
  };
}

async function triggerExtraction(projectRoot: string, sessionId: string): Promise<void> {
  try {
    const cp = await import("node:child_process");
    const path = await import("node:path");
    const url = await import("node:url");
    const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
    const cliPath = path.join(currentDir, "../../cli/index.js");

    const child = cp.spawn(process.execPath, [cliPath, "extract", sessionId], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    console.error(`[dev-mem/antigravity] Extraction trigger skipped: ${(error as Error).message}`);
  }
}

async function main() {
  const payload = parseInput();
  if (!payload) {
    process.exit(0);
  }

  try {
    const projectRoot =
      payload.cwd ||
      (Array.isArray(payload.workspacePaths) && typeof payload.workspacePaths[0] === "string" && payload.workspacePaths[0].trim()
        ? payload.workspacePaths[0]
        : process.cwd());
    const sessionId = payload.conversationId;
    const capture = new DeterministicCapture({ projectRoot, agent: "antigravity", sessionId });

    switch (payload.hookEventName) {
      case "SessionStart": {
        capture.startSession();
        retryPendingExtractions(projectRoot, sessionId);

        try {
          const { importSharedGraph } = await import("../../core/sync/index.js");
          importSharedGraph(projectRoot);
        } catch {}

        let currentFiles: string[] = [];
        try {
          const gitSnap = capture.captureGit();
          currentFiles = Array.isArray(gitSnap.status) ? gitSnap.status.map((s) => s.path) : [];
        } catch {}

        const { retrieveContext, generateInjectionString } = await import("../../core/retrieval/index.js");
        const { checkRegressionRisk, formatRegressionWarning } = await import("../../core/regression/index.js");
        const { filterUnseenNodes } = await import("../../core/retrieval/session-dedup.js");
        const currentTask = typeof payload.lastUserInput === "string" && payload.lastUserInput.trim()
          ? payload.lastUserInput.trim()
          : undefined;

        const regressionMatches = checkRegressionRisk({
          projectRoot,
          currentFiles,
          confidenceThreshold: 0.6,
        });
        const regressionWarning = formatRegressionWarning(regressionMatches);

        const nodes = retrieveContext({ projectRoot, currentFiles, currentTask });
        const unseenNodes = filterUnseenNodes(projectRoot, sessionId, nodes);
        const contextBlock = generateInjectionString(unseenNodes);

        const additionalContext = [regressionWarning, contextBlock].filter(Boolean).join("\n\n");
        if (additionalContext) {
          console.log(JSON.stringify({
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: additionalContext,
                },
              },
            ],
          }));
        } else {
          console.log("{}");
        }
        break;
      }

      case "PreToolUse": {
        const toolCall = recordFor(payload.toolCall);
        const toolName = stringFor(toolCall.name);
        const toolArgs = recordFor(toolCall.args);
        const { command, args, touchedFile } = extractToolDetails(toolName, toolArgs);

        capture.recordToolCall({
          command,
          args,
          exit_code: -1,
        });

        let warning = "";
        if (touchedFile && FILE_WRITE_TOOLS.has(toolName)) {
          const { checkRegressionRisk, formatRegressionWarning } = await import("../../core/regression/index.js");
          const matches = checkRegressionRisk({
            projectRoot,
            currentFiles: [touchedFile],
            confidenceThreshold: 0.6,
          });
          warning = formatRegressionWarning(matches);
        }

        console.log(JSON.stringify(warning ? { decision: "allow", reason: warning } : { decision: "allow" }));
        break;
      }

      case "PostToolUse": {
        const toolCall = recordFor(payload.toolCall);
        const toolName = stringFor(toolCall.name);
        const toolArgs = recordFor(toolCall.args);
        const { command, args } = extractToolDetails(toolName, toolArgs);
        const errorText = typeof payload.error === "string" && payload.error.trim() ? payload.error : undefined;

        capture.recordToolCall({
          command,
          args,
          exit_code: errorText ? 1 : 0,
          stderr: errorText,
        });

        console.log("{}");
        break;
      }

      case "Stop": {
        try {
          capture.captureGit();
        } catch {}
        capture.endSession();
        if (capture.getEvents().some((event) => event.session_id === sessionId && event.type === "session_start")) {
          await triggerExtraction(projectRoot, sessionId);
        }
        console.log("{}");
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("[Dev-Mem/Antigravity] Hook error:", err);
  }

  process.exit(0);
}

main();
