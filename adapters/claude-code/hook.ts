#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { DeterministicCapture } from "../../core/capture/index.js";
import type { ClaudeCodeHookInput } from "./types.js";

function parseInput(): ClaudeCodeHookInput | null {
  try {
    const inputStr = readFileSync(0, "utf-8");
    if (!inputStr) return null;
    return JSON.parse(inputStr) as ClaudeCodeHookInput;
  } catch (e) {
    return null;
  }
}

function main() {
  const payload = parseInput();
  if (!payload) {
    process.exit(0);
  }

  const projectRoot = payload.cwd || process.cwd();

  const capture = new DeterministicCapture({
    projectRoot,
    agent: "claude-code",
    sessionId: payload.session_id,
  });

  switch (payload.hook_event_name) {
    case "SessionStart":
      capture.startSession();
      capture.captureGit();
      break;

    case "PostToolUse": {
      const toolName = payload.tool_name;
      const toolInput = payload.tool_input || {};
      const toolResponse = payload.tool_response || {};

      let command = toolName;
      let args: string[] = [];
      let exitCode = 0;
      let stdout: string | undefined;
      let stderr: string | undefined;

      if (toolName === "Bash" || toolName === "PowerShell") {
        command = toolInput.command || toolName;
        stdout = toolResponse.stdout;
        stderr = toolResponse.stderr;
      } else if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
        command = toolName;
        args = [toolInput.file_path];
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
      break;
    }

    case "Stop":
      capture.captureGit();
      break;

    case "SessionEnd":
      capture.endSession();
      break;

    default:
      break;
  }

  process.exit(0);
}

main();
