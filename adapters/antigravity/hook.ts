#!/usr/bin/env node
/**
 * Dev-Mem Antigravity CLI/IDE adapter hook handler.
 *
 * Installed as: .agents/hooks/dev-mem-<event>.js
 * Invoked by:  Antigravity (`agy`) on each lifecycle event
 * Protocol:    JSON via stdin (camelCase fields) -> JSON via stdout
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DeterministicCapture } from "../../core/capture/index.js";
import { retryPendingExtractions } from "../../core/extraction-retry.js";
import { recordFor, stringFor } from "../../core/hook-safety.js";
import { ANTIGRAVITY_ALL_EVENTS } from "./index.js";
import type { AntigravityHookEvent, AntigravityNormalizedHookInput } from "./types.js";

const FILE_MUTATION_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "Write",
  "Edit",
  "str_replace_editor",
]);

const FILE_READ_TOOLS = new Set(["view_file", "Read"]);
const SHELL_TOOLS = new Set(["run_command", "Bash", "PowerShell", "Terminal"]);

interface ParsedToolInvocation {
  toolName: string;
  command: string;
  args: string[];
  touchedFile?: string;
  isMutation: boolean;
  editSnippet: string;
}

function parseCliEvent(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--event" && typeof argv[i + 1] === "string" && argv[i + 1].trim() !== "") {
      return argv[i + 1].trim();
    }
    if (arg.startsWith("--event=") && arg.slice("--event=".length).trim() !== "") {
      return arg.slice("--event=".length).trim();
    }
  }
  return undefined;
}

interface ParsedHookResult {
  payload: AntigravityNormalizedHookInput | null;
  detectedEvent?: string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const val of values) {
    if (typeof val === "string") return val;
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const val of values) {
    if (typeof val === "string" && val.trim() !== "") return val;
  }
  return undefined;
}

function firstFiniteNumber(fallback: number, ...values: unknown[]): number {
  for (const val of values) {
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return fallback;
}

function normalizeTouchedPath(rawPath: string, projectRoot: string): string {
  if (!rawPath) return "";
  if (isAbsolute(rawPath)) {
    const rel = relative(resolve(projectRoot), resolve(rawPath));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !isAbsolute(rel)) {
      return rel.replace(/\\/g, "/");
    }
    return rawPath.replace(/\\/g, "/");
  }
  return rawPath.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function parseInput(cliEvent?: string): ParsedHookResult {
  try {
    const inputStr = readFileSync(0, "utf-8");
    if (!inputStr || inputStr.trim() === "") return { payload: null, detectedEvent: cliEvent };

    let raw: unknown;
    try {
      raw = JSON.parse(inputStr);
    } catch (error) {
      console.error(`[dev-mem/antigravity] Ignoring malformed hook JSON: ${(error as Error).message}`);
      return { payload: null, detectedEvent: cliEvent };
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      console.error("[dev-mem/antigravity] Ignoring hook payload: expected an object");
      return { payload: null, detectedEvent: cliEvent };
    }

    const rawObj = raw as Record<string, unknown>;
    const rawEventName = typeof rawObj.hook_event_name === "string" ? rawObj.hook_event_name.trim() : "";
    const detectedEvent = cliEvent ?? (rawEventName || undefined);

    const sessionId = stringFor(rawObj.session_id, stringFor(rawObj.conversationId, ""));
    if (!sessionId) {
      console.error("[dev-mem/antigravity] Ignoring hook payload: missing string session_id");
      return { payload: null, detectedEvent };
    }

    const hookEventName = cliEvent ?? rawEventName;
    if (!(ANTIGRAVITY_ALL_EVENTS as readonly string[]).includes(hookEventName)) {
      console.error("[dev-mem/antigravity] Ignoring hook payload: unsupported hook_event_name");
      return { payload: null, detectedEvent };
    }

    const firstWorkspace = Array.isArray(rawObj.workspacePaths)
      ? stringFor(rawObj.workspacePaths[0], "")
      : "";
    const cwd = stringFor(rawObj.cwd, firstWorkspace || process.cwd());

    return {
      payload: {
        ...rawObj,
        session_id: sessionId,
        cwd,
        hook_event_name: hookEventName as AntigravityHookEvent,
      } as AntigravityNormalizedHookInput,
      detectedEvent,
    };
  } catch (error) {
    console.error(`[dev-mem/antigravity] Ignoring unreadable hook input: ${(error as Error).message}`);
    return { payload: null, detectedEvent: cliEvent };
  }
}

function extractEditSnippet(toolArgs: Record<string, unknown>): string {
  const direct = firstNonEmptyString(
    toolArgs.ReplacementContent,
    toolArgs.CodeContent,
    toolArgs.new_string,
    toolArgs.content,
  );
  if (direct) return direct.slice(0, 500);

  if (Array.isArray(toolArgs.ReplacementChunks)) {
    const combined = toolArgs.ReplacementChunks
      .map((chunk) => stringFor(recordFor(chunk).ReplacementContent, ""))
      .filter(Boolean)
      .join("\n");
    if (combined) return combined.slice(0, 500);
  }
  return "";
}

function extractToolInvocation(
  payload: AntigravityNormalizedHookInput,
  projectRoot: string,
): ParsedToolInvocation {
  const toolCall = recordFor(payload.toolCall ?? payload.tool_call);
  const toolName = stringFor(toolCall.name, stringFor(payload.tool_name));
  const toolArgs = recordFor(toolCall.args ?? toolCall.arguments ?? payload.tool_input);

  if (SHELL_TOOLS.has(toolName)) {
    const command = stringFor(toolArgs.CommandLine, stringFor(toolArgs.command, toolName));
    return {
      toolName,
      command,
      args: [],
      isMutation: false,
      editSnippet: "",
    };
  }

  if (FILE_MUTATION_TOOLS.has(toolName) || FILE_READ_TOOLS.has(toolName)) {
    const rawFilePath =
      firstNonEmptyString(
        toolArgs.TargetFile,
        toolArgs.AbsolutePath,
        toolArgs.file_path,
        toolArgs.path,
      ) ?? "";
    const filePath = normalizeTouchedPath(rawFilePath, projectRoot);
    return {
      toolName,
      command: toolName,
      args: filePath ? [filePath] : [],
      touchedFile: filePath || undefined,
      isMutation: FILE_MUTATION_TOOLS.has(toolName),
      editSnippet: FILE_MUTATION_TOOLS.has(toolName) ? extractEditSnippet(toolArgs) : "",
    };
  }

  return {
    toolName,
    command: toolName,
    args: [JSON.stringify(toolArgs)],
    isMutation: false,
    editSnippet: "",
  };
}

async function getMutationRegressionWarning(
  projectRoot: string,
  sessionId: string,
  invocation: ParsedToolInvocation,
): Promise<string> {
  if (!invocation.isMutation || !invocation.touchedFile) {
    return "";
  }
  const { checkRegressionRisk, formatRegressionWarning } = await import("../../core/regression/index.js");
  const { filterUnseenWarnings } = await import("../../core/retrieval/session-dedup.js");
  const matches = filterUnseenWarnings(
    projectRoot,
    sessionId,
    checkRegressionRisk({
      projectRoot,
      currentFiles: [invocation.touchedFile],
      currentTask: invocation.editSnippet || undefined,
      confidenceThreshold: 0.6,
    }),
  );
  return formatRegressionWarning(matches);
}

async function main() {
  if (process.env.DEV_MEM_DISABLE_HOOKS === "1") {
    process.exit(0);
  }

  const cliEvent = parseCliEvent(process.argv.slice(2));
  const { payload, detectedEvent } = parseInput(cliEvent);
  const isPreToolUse = detectedEvent === "PreToolUse" || cliEvent === "PreToolUse";
  if (!payload) {
    if (isPreToolUse) {
      console.log(JSON.stringify({ decision: "allow" }));
    }
    process.exit(0);
  }

  let preToolUseEmitted = false;
  try {
    const projectRoot = payload.cwd || process.cwd();
    const capture = new DeterministicCapture({
      projectRoot,
      agent: "antigravity",
      sessionId: payload.session_id,
    });

    switch (payload.hook_event_name) {
      case "SessionStart": {
        capture.startSession();
        retryPendingExtractions(projectRoot, payload.session_id);

        try {
          const { importSharedGraph } = await import("../../core/sync/index.js");
          importSharedGraph(projectRoot);
        } catch {
          // Shared graph sync is optional
        }

        let currentFiles: string[] = [];
        try {
          const gitSnap = capture.captureGit();
          currentFiles = Array.isArray(gitSnap.status) ? gitSnap.status.map((s) => s.path) : [];
        } catch {
          // Non-git workspace: continue without git status files
        }

        const { retrieveContext, generateInjectionString } = await import("../../core/retrieval/index.js");
        const { checkRegressionRisk, formatRegressionWarning } = await import("../../core/regression/index.js");
        const { filterUnseenNodes, filterUnseenWarnings } = await import("../../core/retrieval/session-dedup.js");

        const currentTask = stringFor(payload.prompt, stringFor(payload.message, "")).trim() || undefined;
        const regressionMatches = filterUnseenWarnings(
          projectRoot,
          payload.session_id,
          checkRegressionRisk({
            projectRoot,
            currentFiles,
            currentTask,
            confidenceThreshold: 0.6,
          }),
        );
        const regressionWarning = formatRegressionWarning(regressionMatches);

        const nodes = retrieveContext({
          projectRoot,
          currentFiles,
          currentTask,
          currentSessionId: payload.session_id,
        });
        const unseenNodes = filterUnseenNodes(projectRoot, payload.session_id, nodes);
        const contextBlock = generateInjectionString(unseenNodes);

        const additionalContext = [regressionWarning, contextBlock].filter(Boolean).join("\n\n");
        if (additionalContext) {
          console.log(JSON.stringify({ additionalContext }));
        }
        break;
      }

      case "PreInvocation": {
        const promptText = stringFor(payload.prompt, stringFor(payload.message, "")).trim();
        if (!promptText) break;

        const { retrieveContext, generateInjectionString } = await import("../../core/retrieval/index.js");
        const { filterUnseenNodes } = await import("../../core/retrieval/session-dedup.js");

        const candidates = retrieveContext({
          projectRoot,
          currentTask: promptText,
          currentSessionId: payload.session_id,
          minRelevance: 0.08,
        });
        const unseen = filterUnseenNodes(projectRoot, payload.session_id, candidates);
        const contextBlock = generateInjectionString(unseen);
        if (contextBlock) {
          console.log(JSON.stringify({ additionalContext: contextBlock }));
        }
        break;
      }

      case "PreToolUse": {
        const invocation = extractToolInvocation(payload, projectRoot);
        capture.recordToolCall({
          command: invocation.command,
          args: invocation.args,
          exit_code: -1,
        });

        const warning = await getMutationRegressionWarning(projectRoot, payload.session_id, invocation);
        console.log(
          JSON.stringify({
            decision: "allow",
            ...(warning ? { additionalContext: warning } : {}),
          }),
        );
        preToolUseEmitted = true;
        break;
      }

      case "PostToolUse": {
        const invocation = extractToolInvocation(payload, projectRoot);
        const toolOutputRec = recordFor(payload.toolOutput);
        const toolResponse = recordFor(payload.toolResponse ?? payload.tool_response);

        const stdout = firstString(
          payload.toolOutput,
          toolOutputRec.stdout,
          toolOutputRec.output,
          toolResponse.stdout,
          toolResponse.output,
        );
        const stderr = firstString(toolOutputRec.stderr, toolResponse.stderr);
        const exitCode = firstFiniteNumber(
          0,
          payload.exitCode,
          payload.exit_code,
          toolOutputRec.exitCode,
          toolOutputRec.exit_code,
          toolResponse.exitCode,
          toolResponse.exit_code,
        );

        capture.recordToolCall({
          command: invocation.command,
          args: invocation.args,
          exit_code: exitCode,
          stdout,
          stderr,
        });

        const warning = await getMutationRegressionWarning(projectRoot, payload.session_id, invocation);
        if (warning) {
          console.log(JSON.stringify({ additionalContext: warning }));
        }
        break;
      }

      // PostInvocation fires per-turn; extraction runs only on Stop at conversation execution end.
      case "PostInvocation":
        break;

      case "Stop": {
        try {
          capture.captureGit();
        } catch {
          // Non-git workspace: continue to record session end
        }
        capture.endSession();

        if (!capture.getEvents().some((event) => event.session_id === payload.session_id && event.type === "session_start")) {
          console.error(`[dev-mem/antigravity] Ignoring Stop without a prior SessionStart for ${payload.session_id}`);
          break;
        }

        const cp = await import("node:child_process");
        const path = await import("node:path");
        const url = await import("node:url");
        const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
        const cliPath = path.join(currentDir, "../../cli/index.js");

        const child = cp.spawn(process.execPath, [cliPath, "extract", payload.session_id], {
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
    console.error("[dev-mem/antigravity] Hook error:", err);
    if ((payload.hook_event_name === "PreToolUse" || isPreToolUse) && !preToolUseEmitted) {
      console.log(JSON.stringify({ decision: "allow" }));
    }
  }

  process.exit(0);
}

main();
