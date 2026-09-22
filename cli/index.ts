#!/usr/bin/env node

const COMMANDS = [
  "install",
  "status",
  "query",
  "inspect",
  "uninstall",
  "extract",
  "wrap",
] as const;

type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { ensureLocalDataDir, getEventsLogPath } from "../core/local-data.js";
import { GraphStore } from "../core/graph/index.js";
import { acquireExtractionLock, markExtractionComplete } from "../core/extraction-lock.js";

function getHookScriptCode(eventName: string): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const distDir = join(currentDir, "..").replace(/\\/g, "/");

  // Keep installed hooks on the same hardened implementation as the bundled
  // adapter. The event-specific file is only the host registration surface.
  return `import { pathToFileURL } from "node:url";
await import(pathToFileURL("${distDir}/adapters/claude-code/hook.js").href);
`;

  return `import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

let captureModule;
let retrievalModule;
let regressionModule;

try {
  captureModule = await import("dev-mem/capture");
} catch {
  captureModule = await import(pathToFileURL("${distDir}/core/capture/index.js").href);
}

try {
  retrievalModule = await import("dev-mem/retrieval");
} catch {
  retrievalModule = await import(pathToFileURL("${distDir}/core/retrieval/index.js").href);
}

try {
  regressionModule = await import("dev-mem/regression");
} catch {
  regressionModule = await import(pathToFileURL("${distDir}/core/regression/index.js").href);
}

const { DeterministicCapture } = captureModule;
const { retrieveContext, generateInjectionString } = retrievalModule;
const { checkRegressionRisk, formatRegressionWarning } = regressionModule;

const inputStr = readFileSync(0, "utf-8");
if (!inputStr) process.exit(0);
const payload = JSON.parse(inputStr);
const cwd = payload.cwd || process.cwd();

const capture = new DeterministicCapture({
  projectRoot: cwd,
  agent: "claude-code",
  sessionId: payload.session_id,
});

async function main() {
  try {
    if ("${eventName}" === "SessionStart") {
      capture.startSession();
      const gitSnap = capture.captureGit();

      // Files currently modified/staged in working tree (if any)
      const currentFiles = Array.isArray(gitSnap.status) ? gitSnap.status.map((s) => s.path) : [];

      // §8.1 Regression Intelligence at session start
      const regressionMatches = checkRegressionRisk({
        projectRoot: cwd,
        currentFiles,
        confidenceThreshold: 0.6,
      });
      const regressionWarning = formatRegressionWarning(regressionMatches);

      // §8 Budget-constrained ranked retrieval with graph proximity.
      // Budget is omitted: retrieveContext uses an adaptive default.
      const nodes = retrieveContext({ projectRoot: cwd, currentFiles });
      const contextBlock = generateInjectionString(nodes);

      const additionalContext = [regressionWarning, contextBlock]
        .filter(Boolean)
        .join("\\n\\n");

      if (additionalContext) {
        console.log(JSON.stringify({
          hookSpecificOutput: { additionalContext }
        }));
      }
    } else if ("${eventName}" === "PostToolUse") {
      const toolName = payload.tool_name;
      const toolInput = payload.tool_input || {};
      const toolResponse = payload.tool_response || {};

      let command = toolName;
      let args = [];
      let stdout, stderr;
      let touchedFile;

      if (toolName === "Bash" || toolName === "PowerShell") {
        command = toolInput.command || toolName;
        stdout = toolResponse.stdout;
        stderr = toolResponse.stderr;
      } else if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
        args = [toolInput.file_path];
        touchedFile = toolInput.file_path;
      } else {
        args = [JSON.stringify(toolInput)];
      }

      capture.recordToolCall({
        command,
        args,
        exit_code: 0,
        stdout,
        stderr,
      });

      // §8.1 Mid-session regression: check the exact file being written/edited
      if (touchedFile && (toolName === "Write" || toolName === "Edit")) {
        const matches = checkRegressionRisk({
          projectRoot: cwd,
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
    } else if ("${eventName}" === "Stop") {
      capture.captureGit();
    } else if ("${eventName}" === "SessionEnd") {
      capture.endSession();
      const { spawn } = await import("node:child_process");
      const { join } = await import("node:path");

      const child = spawn("node", [join("${distDir}", "cli/index.js"), "extract", payload.session_id], {
        cwd,
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    }
  } catch (err) {
    console.error("[Dev-Mem] Hook error:", err);
  }
  process.exit(0);
}

main();
`;
}

function getCodexHookScriptCode(eventName: string): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const distDir = join(currentDir, "..").replace(/\\/g, "/");

  return `import { pathToFileURL } from "node:url";
await import(pathToFileURL("${distDir}/adapters/codex/hook.js").href);
`;

  return `import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

let captureModule;
let retrievalModule;
let regressionModule;

try {
  captureModule = await import("dev-mem/capture");
} catch {
  captureModule = await import(pathToFileURL("${distDir}/core/capture/index.js").href);
}

try {
  retrievalModule = await import("dev-mem/retrieval");
} catch {
  retrievalModule = await import(pathToFileURL("${distDir}/core/retrieval/index.js").href);
}

try {
  regressionModule = await import("dev-mem/regression");
} catch {
  regressionModule = await import(pathToFileURL("${distDir}/core/regression/index.js").href);
}

const { DeterministicCapture } = captureModule;
const { retrieveContext, generateInjectionString } = retrievalModule;
const { checkRegressionRisk, formatRegressionWarning } = regressionModule;

const inputStr = readFileSync(0, "utf-8");
if (!inputStr) process.exit(0);
const payload = JSON.parse(inputStr);
const cwd = payload.cwd || process.cwd();

const capture = new DeterministicCapture({
  projectRoot: cwd,
  agent: "codex",
  sessionId: payload.session_id,
});

async function main() {
  try {
    if ("${eventName}" === "SessionStart") {
      capture.startSession();
      const gitSnap = capture.captureGit();

      const currentFiles = Array.isArray(gitSnap.status) ? gitSnap.status.map((s) => s.path) : [];

      const regressionMatches = checkRegressionRisk({
        projectRoot: cwd,
        currentFiles,
        confidenceThreshold: 0.6,
      });
      const regressionWarning = formatRegressionWarning(regressionMatches);

      const nodes = retrieveContext({ projectRoot: cwd, currentFiles });
      const contextBlock = generateInjectionString(nodes);

      const additionalContext = [regressionWarning, contextBlock]
        .filter(Boolean)
        .join("\\\\n\\\\n");

      if (additionalContext) {
        console.log(JSON.stringify({
          hookSpecificOutput: { additionalContext }
        }));
      }
    } else if ("${eventName}" === "PreToolUse") {
      const toolName = payload.tool_name;
      const toolInput = payload.tool_input || {};
      let command = toolName;
      let args = [];
      let touchedFile;

      if (toolName === "Bash") {
        command = toolInput.command || toolName;
      } else if (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor") {
        args = [toolInput.file_path ?? toolInput.path ?? ""];
        touchedFile = toolInput.file_path ?? toolInput.path;
      } else {
        args = [JSON.stringify(toolInput)];
      }

      capture.recordToolCall({ command, args, exit_code: -1 });

      if (touchedFile && (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor")) {
        const matches = checkRegressionRisk({
          projectRoot: cwd,
          currentFiles: [touchedFile],
          confidenceThreshold: 0.6,
        });
        const warning = formatRegressionWarning(matches);
        if (warning) {
          console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: warning } }));
        }
      }
    } else if ("${eventName}" === "PostToolUse") {
      const toolName = payload.tool_name;
      const toolInput = payload.tool_input || {};
      const toolResponse = payload.tool_response || {};

      let command = toolName;
      let args = [];
      let stdout, stderr;
      let exitCode = toolResponse.exit_code ?? 0;
      let touchedFile;

      if (toolName === "Bash") {
        command = toolInput.command || toolName;
        stdout = toolResponse.output ?? toolResponse.stdout;
        stderr = toolResponse.stderr;
      } else if (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor") {
        args = [toolInput.file_path ?? toolInput.path ?? ""];
        touchedFile = toolInput.file_path ?? toolInput.path;
      } else {
        args = [JSON.stringify(toolInput)];
      }

      capture.recordToolCall({ command, args, exit_code: exitCode, stdout, stderr });

      if (touchedFile && (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor")) {
        const matches = checkRegressionRisk({
          projectRoot: cwd,
          currentFiles: [touchedFile],
          confidenceThreshold: 0.6,
        });
        const warning = formatRegressionWarning(matches);
        if (warning) {
          console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: warning } }));
        }
      }
    } else if ("${eventName}" === "Stop") {
      capture.captureGit();
    } else if ("${eventName}" === "SessionEnd") {
      capture.endSession();
      const { spawn } = await import("node:child_process");
      const { join } = await import("node:path");

      const child = spawn("node", [join("${distDir}", "cli/index.js"), "extract", payload.session_id], {
        cwd,
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    }
  } catch (err) {
    console.error("[Dev-Mem/Codex] Hook error:", err);
  }
  process.exit(0);
}

main();
`;
}


function getCursorHookScriptCode(eventName: string): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const distDir = join(currentDir, "..").replace(/\\/g, "/");

  return `import { pathToFileURL } from "node:url";
await import(pathToFileURL("${distDir}/adapters/cursor/hook.js").href);
`;

  return `import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

let captureModule;
let retrievalModule;
let regressionModule;
let logModule;

try {
  captureModule = await import("dev-mem/capture");
} catch {
  captureModule = await import(pathToFileURL("${distDir}/core/capture/index.js").href);
}

try {
  retrievalModule = await import("dev-mem/retrieval");
} catch {
  retrievalModule = await import(pathToFileURL("${distDir}/core/retrieval/index.js").href);
}

try {
  regressionModule = await import("dev-mem/regression");
} catch {
  regressionModule = await import(pathToFileURL("${distDir}/core/regression/index.js").href);
}

try {
  logModule = await import(pathToFileURL("${distDir}/core/capture/log.js").href);
} catch {
  // fallback if needed
}

const { DeterministicCapture } = captureModule;
const { retrieveContext, generateInjectionString } = retrievalModule;
const { checkRegressionRisk, formatRegressionWarning } = regressionModule;
const { EventLog } = logModule;

const inputStr = readFileSync(0, "utf-8");
if (!inputStr) process.exit(0);
const payload = JSON.parse(inputStr);
const cwd = payload.cwd || process.cwd();

const capture = new DeterministicCapture({
  projectRoot: cwd,
  agent: "cursor",
  sessionId: payload.session_id,
});

function getExtractionThreshold(projectRoot) {
  const configPath = join(projectRoot, ".dev-mem", "config.yml");
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const match = content.match(/extraction_event_threshold:\\s*(\\d+)/);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
    } catch {
      // fallback to default
    }
  }
  return 10;
}

async function triggerExtractionIfThresholdMet(projectRoot, sessionId) {
  try {
    const log = new EventLog({ persistPath: join(projectRoot, ".dev-mem", "events.jsonl") });
    const events = log.getEvents().filter(e => e.session_id === sessionId && e.type === "tool_call" && e.exit_code !== -1);
    const threshold = getExtractionThreshold(projectRoot);

    if (events.length > 0 && events.length % threshold === 0) {
      const cp = await import("node:child_process");
      const path = await import("node:path");
      
      const child = cp.spawn("node", [join("${distDir}", "cli/index.js"), "extract", sessionId], {
        cwd: projectRoot,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
  } catch (err) {
    // Fail gracefully
  }
}

async function main() {
  try {
    if ("${eventName}" === "sessionStart") {
      capture.startSession();
      const gitSnap = capture.captureGit();

      const currentFiles = Array.isArray(gitSnap.status) ? gitSnap.status.map((s) => s.path) : [];

      const regressionMatches = checkRegressionRisk({
        projectRoot: cwd,
        currentFiles,
        confidenceThreshold: 0.6,
      });
      const regressionWarning = formatRegressionWarning(regressionMatches);

      const nodes = retrieveContext({ projectRoot: cwd, currentFiles });
      const contextBlock = generateInjectionString(nodes);

      const additionalContext = [regressionWarning, contextBlock]
        .filter(Boolean)
        .join("\\\\n\\\\n");

      if (additionalContext) {
        console.log(JSON.stringify({
          hookSpecificOutput: { additionalContext }
        }));
      }
    } else if ("${eventName}" === "preToolUse") {
      const toolName = payload.tool_name;
      const toolInput = payload.tool_input || {};
      let command = toolName;
      let args = [];
      let touchedFile;

      if (toolName === "Bash" || toolName === "Terminal") {
        command = toolInput.command || toolName;
      } else if (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor") {
        args = [toolInput.file_path ?? toolInput.path ?? ""];
        touchedFile = toolInput.file_path ?? toolInput.path;
      } else {
        args = [JSON.stringify(toolInput)];
      }

      capture.recordToolCall({ command, args, exit_code: -1 });

      if (touchedFile && (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor")) {
        const matches = checkRegressionRisk({
          projectRoot: cwd,
          currentFiles: [touchedFile],
          confidenceThreshold: 0.6,
        });
        const warning = formatRegressionWarning(matches);
        if (warning) {
          console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: warning } }));
        }
      }
    } else if ("${eventName}" === "postToolUse") {
      const toolName = payload.tool_name;
      const toolInput = payload.tool_input || {};
      const toolResponse = payload.tool_response || {};

      let command = toolName;
      let args = [];
      let stdout, stderr;
      let exitCode = toolResponse.exit_code ?? 0;
      let touchedFile;

      if (toolName === "Bash" || toolName === "Terminal") {
        command = toolInput.command || toolName;
        stdout = toolResponse.output ?? toolResponse.stdout;
        stderr = toolResponse.stderr;
      } else if (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor") {
        args = [toolInput.file_path ?? toolInput.path ?? ""];
        touchedFile = toolInput.file_path ?? toolInput.path;
      } else {
        args = [JSON.stringify(toolInput)];
      }

      capture.recordToolCall({ command, args, exit_code: exitCode, stdout, stderr });

      if (touchedFile && (toolName === "Write" || toolName === "Edit" || toolName === "str_replace_editor")) {
        const matches = checkRegressionRisk({
          projectRoot: cwd,
          currentFiles: [touchedFile],
          confidenceThreshold: 0.6,
        });
        const warning = formatRegressionWarning(matches);
        if (warning) {
          console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: warning } }));
        }
      }
    } else if ("${eventName}" === "stop") {
      capture.captureGit();
      await triggerExtractionIfThresholdMet(cwd, payload.session_id);
    }
  } catch (err) {
    console.error("[Dev-Mem/Cursor] Hook error:", err);
  }
  process.exit(0);
}

main();
`;
}

function installClaudeCodeHooks(cwd: string) {
  const claudeDir = join(cwd, ".claude");
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const hooksDir = join(claudeDir, "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const events = ["SessionStart", "PostToolUse", "Stop", "SessionEnd"];
  const hookConfigs: Record<string, any[]> = {};

  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, '-$1').replace(/^-/, '')}.js`;
    const scriptPath = join(hooksDir, scriptName);
    writeFileSync(scriptPath, getHookScriptCode(event), "utf8");

    hookConfigs[event] = [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/${scriptName}`]
          }
        ]
      }
    ];
  }

  const settingsPath = join(claudeDir, "settings.json");
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {}
  }

  if (!settings.hooks) settings.hooks = {};

  for (const event of events) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const existing = settings.hooks[event].find((h: any) => h.hooks && h.hooks[0] && h.hooks[0].args && h.hooks[0].args[0].includes("dev-mem"));
    if (!existing) {
      settings.hooks[event].push(hookConfigs[event][0]);
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

function installCodexHooks(cwd: string) {
  const codexDir = join(cwd, ".codex");
  if (!existsSync(codexDir)) {
    mkdirSync(codexDir, { recursive: true });
  }

  const hooksDir = join(codexDir, "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  // Both Claude Code and Codex support PreToolUse.
  const events = ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];

  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, '-$1').replace(/^-/, '')}.js`;
    const scriptPath = join(hooksDir, scriptName);
    writeFileSync(scriptPath, getCodexHookScriptCode(event), "utf8");
  }

  // Codex uses .codex/hooks.json — separate file, not embedded in a settings file.
  const hooksJsonPath = join(codexDir, "hooks.json");
  let hooksJson: any = { hooks: {} };
  if (existsSync(hooksJsonPath)) {
    try {
      hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (!hooksJson.hooks) hooksJson.hooks = {};
    } catch {}
  }

  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, '-$1').replace(/^-/, '')}.js`;
    if (!hooksJson.hooks[event]) hooksJson.hooks[event] = [];

    const existing = hooksJson.hooks[event].find((h: any) => {
      const cmd: string = h.command ?? (Array.isArray(h.hooks) ? h.hooks[0]?.command : "");
      return cmd && cmd.includes("dev-mem");
    });

    if (!existing) {
      const entry: any = {
        type: "command",
        command: `node .codex/hooks/${scriptName}`,
        // Explicitly use SECONDS (Codex standard) to guarantee max window.
        timeout: 3
      };
      
      if (event === "SessionEnd") {
        // We use detached spawn internally anyway, but we set async: true
        // just to be compliant with best practices for non-blocking hooks.
        // It has no effect on SessionEnd specifically (which is always sync).
        entry.async = true;
      }
      hooksJson.hooks[event].push(entry);
    }
  }

  writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2), "utf8");
}

function installCursorHooks(cwd: string) {
  const cursorDir = join(cwd, ".cursor");
  if (!existsSync(cursorDir)) {
    mkdirSync(cursorDir, { recursive: true });
  }

  const hooksDir = join(cursorDir, "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  // Cursor uses camelCase event names. sessionEnd is omitted (unreliable).
  const events = ["sessionStart", "preToolUse", "postToolUse", "stop"];

  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase()}.js`;
    const scriptPath = join(hooksDir, scriptName);
    writeFileSync(scriptPath, getCursorHookScriptCode(event), "utf8");
  }

  const hooksJsonPath = join(cursorDir, "hooks.json");
  let hooksJson: any = { version: 1, hooks: {} };
  if (existsSync(hooksJsonPath)) {
    try {
      hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (!hooksJson.hooks) hooksJson.hooks = {};
    } catch {}
  }

  for (const event of events) {
    const scriptName = `dev-mem-${event.toLowerCase()}.js`;
    if (!hooksJson.hooks[event]) hooksJson.hooks[event] = [];

    const existing = hooksJson.hooks[event].find((h: any) => {
      const cmd: string = h.command ?? "";
      return cmd && cmd.includes("dev-mem");
    });

    if (!existing) {
      hooksJson.hooks[event].push({
        command: `node .cursor/hooks/${scriptName}`,
        matcher: "*",
        timeout: 3
      });
    }
  }

  writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2), "utf8");
}

function installHooks(cwd: string) {
  const claudePresent = existsSync(join(cwd, ".claude"));
  const codexPresent = existsSync(join(cwd, ".codex"));
  const cursorPresent = existsSync(join(cwd, ".cursor"));

  const installedAgents: string[] = [];

  // Default to claude-code if none found, else install for present agents.
  if (claudePresent || (!codexPresent && !cursorPresent)) {
    installClaudeCodeHooks(cwd);
    installedAgents.push("claude-code");
  }

  if (codexPresent) {
    installCodexHooks(cwd);
    installedAgents.push("codex");
  }

  if (cursorPresent) {
    installCursorHooks(cwd);
    installedAgents.push("cursor");
  }

  ensureLocalDataDir(cwd);
  return installedAgents;
}

function uninstallCodexHooks(cwd: string) {
  const codexDir = join(cwd, ".codex");
  const hooksJsonPath = join(codexDir, "hooks.json");

  if (existsSync(hooksJsonPath)) {
    try {
      const hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (hooksJson.hooks) {
        for (const event of Object.keys(hooksJson.hooks)) {
          hooksJson.hooks[event] = hooksJson.hooks[event].filter((h: any) => {
            const cmd: string = h.command ?? "";
            return !cmd.includes("dev-mem");
          });
          if (hooksJson.hooks[event].length === 0) {
            delete hooksJson.hooks[event];
          }
        }
      }
      writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2), "utf8");
    } catch {}
  }

  const hooksDir = join(codexDir, "hooks");
  if (existsSync(hooksDir)) {
    const events = ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"];
    for (const event of events) {
      const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, '-$1').replace(/^-/, '')}.js`;
      const scriptPath = join(hooksDir, scriptName);
      if (existsSync(scriptPath)) rmSync(scriptPath);
    }
  }
}

function uninstallCursorHooks(cwd: string) {
  const cursorDir = join(cwd, ".cursor");
  const hooksJsonPath = join(cursorDir, "hooks.json");

  if (existsSync(hooksJsonPath)) {
    try {
      const hooksJson = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
      if (hooksJson.hooks) {
        for (const event of Object.keys(hooksJson.hooks)) {
          hooksJson.hooks[event] = hooksJson.hooks[event].filter((h: any) => {
            const cmd: string = h.command ?? "";
            return !cmd.includes("dev-mem");
          });
          if (hooksJson.hooks[event].length === 0) {
            delete hooksJson.hooks[event];
          }
        }
      }
      writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2), "utf8");
    } catch {}
  }

  const hooksDir = join(cursorDir, "hooks");
  if (existsSync(hooksDir)) {
    const events = ["sessionStart", "preToolUse", "postToolUse", "stop"];
    for (const event of events) {
      const scriptName = `dev-mem-${event.toLowerCase()}.js`;
      const scriptPath = join(hooksDir, scriptName);
      if (existsSync(scriptPath)) rmSync(scriptPath);
    }
  }
}

function uninstallHooks(cwd: string, purge: boolean) {
  // Claude Code
  const claudeDir = join(cwd, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          settings.hooks[event] = settings.hooks[event].filter((h: any) => !(h.hooks && h.hooks[0] && h.hooks[0].args && h.hooks[0].args[0].includes("dev-mem")));
          if (settings.hooks[event].length === 0) {
            delete settings.hooks[event];
          }
        }
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    } catch {}
  }

  const claudeHooksDir = join(claudeDir, "hooks");
  if (existsSync(claudeHooksDir)) {
    const events = ["SessionStart", "PostToolUse", "Stop", "SessionEnd"];
    for (const event of events) {
      const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, '-$1').replace(/^-/, '')}.js`;
      const scriptPath = join(claudeHooksDir, scriptName);
      if (existsSync(scriptPath)) rmSync(scriptPath);
    }
  }

  // Codex
  if (existsSync(join(cwd, ".codex"))) {
    uninstallCodexHooks(cwd);
  }

  // Cursor
  if (existsSync(join(cwd, ".cursor"))) {
    uninstallCursorHooks(cwd);
  }

  if (purge) {
    const devMemDir = join(cwd, ".dev-mem");
    if (existsSync(devMemDir)) {
      rmSync(devMemDir, { recursive: true, force: true });
    }
  }
}


function runStatus(cwd: string): string {
  let output = "";
  try {
    const store = new GraphStore({ projectRoot: cwd });
    output += "Nodes:\n";
    let totalNodes = 0;
    const lifecycleCounts: Record<string, number> = {};
    const types = ["Decision", "FailedApproach", "Constraint", "Discovery", "Convention", "OpenIssue"];
    for (const type of types) {
      const nodes = store.queryByType(type as any);
      totalNodes += nodes.length;
      if (nodes.length > 0) {
        output += `- ${type}: ${nodes.length}\n`;
      }
      for (const n of nodes) {
        lifecycleCounts[n.lifecycle_state] = (lifecycleCounts[n.lifecycle_state] || 0) + 1;
      }
    }
    output += `\nTotal Nodes: ${totalNodes}\n`;
    output += "\nLifecycle States:\n";
    for (const [state, count] of Object.entries(lifecycleCounts)) {
      output += `- ${state}: ${count}\n`;
    }
    store.close();
  } catch (e: any) {
    output += `GraphStore Error: ${e.message}\n`;
  }
  
  const logPath = getEventsLogPath(cwd);
  if (existsSync(logPath)) {
    const stat = statSync(logPath);
    output += `\nLast capture: ${stat.mtime.toISOString()}\n`;
  } else {
    output += "\nLast capture: None\n";
  }
  return output;
}

import { runExtraction } from "../core/extraction/index.js";

async function extractOnce(cwd: string, sessionId: string): Promise<{ skipped: boolean; success: boolean }> {
  let release: (() => void) | null;
  try {
    release = acquireExtractionLock(cwd, sessionId);
  } catch (error) {
    console.error(`[dev-mem] Unable to prepare extraction lock for ${sessionId}: ${(error as Error).message}`);
    return { skipped: true, success: false };
  }
  if (!release) {
    console.error(`[dev-mem] Extraction already running or complete for session ${sessionId}; skipping duplicate trigger`);
    return { skipped: true, success: true };
  }
  try {
    const result = await runExtraction({ projectRoot: cwd, sessionId });
    if (result.success) markExtractionComplete(cwd, sessionId);
    return { skipped: false, success: result.success };
  } finally {
    release();
  }
}

export async function runCli(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [command, ...args] = argv;

  if (!command) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Usage: dev-mem <${COMMANDS.join("|")}>\n`,
    };
  }

  if (!isCommand(command)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown command: ${command}\nUsage: dev-mem <${COMMANDS.join("|")}>\n`,
    };
  }

  const cwd = process.cwd();

  try {
    if (command === "install") {
      const agents = installHooks(cwd);
      let out = `dev-mem hooks installed (agents: ${agents.join(", ")})\n`;
      if (agents.includes("cursor")) {
        out += `\n[Notice for Cursor]: Cursor CLI lacks a reliable SessionEnd event.\nDev-Mem uses an N-accumulated-events trigger (default 10) instead.\nFor a perfect flush when exiting, run your agent via: dev-mem wrap cursor-agent <args>\n`;
      }
      return { exitCode: 0, stdout: out, stderr: "" };
    } else if (command === "status") {
      const output = runStatus(cwd);
      return { exitCode: 0, stdout: output + "\n", stderr: "" };
    } else if (command === "uninstall") {
      const purge = args.includes("--purge");
      uninstallHooks(cwd, purge);
      return { exitCode: 0, stdout: "dev-mem hooks uninstalled\n", stderr: "" };
    } else if (command === "extract") {
      const sessionId = args[0];
      if (!sessionId) {
        return { exitCode: 1, stdout: "", stderr: "Usage: dev-mem extract <sessionId>\n" };
      }
      const result = await extractOnce(cwd, sessionId);
      return { exitCode: result.success ? 0 : 1, stdout: result.skipped ? "Extraction skipped\n" : "Extraction complete\n", stderr: "" };
    } else if (command === "wrap") {
      if (args.length === 0) {
        return { exitCode: 1, stdout: "", stderr: "Usage: dev-mem wrap <command> [args...]\n" };
      }
      return new Promise((resolve) => {
        import("node:child_process").then(({ spawn }) => {
          const child = spawn(args[0], args.slice(1), { stdio: "inherit", shell: true });
          
          child.on("close", async (code) => {
            try {
              const { EventLog } = await import("../core/capture/log.js");
              const log = new EventLog({ persistPath: join(cwd, ".dev-mem", "events.jsonl") });
              const events = log.getEvents();
              if (events.length > 0) {
                const lastSessionId = events[events.length - 1].session_id;
                if (lastSessionId) {
                  process.stdout.write(`\n[dev-mem] Wrapping complete. Flushing remaining events for session ${lastSessionId}...\n`);
                  await extractOnce(cwd, lastSessionId);
                }
              }
            } catch (e: any) {
              process.stderr.write(`[dev-mem] Wrap flush error: ${e.message}\n`);
            }
            resolve({ exitCode: code ?? 0, stdout: "", stderr: "" });
          });
        });
      });
    }
  } catch (e: any) {
    return { exitCode: 1, stdout: "", stderr: e.message + "\n" };
  }

  // Full command logic is a later milestone. Surface exists now (spec §3.4).
  return { exitCode: 0, stdout: "not yet implemented\n", stderr: "" };
}

const isDirectRun = true;

if (isDirectRun) {
  runCli(process.argv.slice(2)).then((result) => {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.exitCode);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
