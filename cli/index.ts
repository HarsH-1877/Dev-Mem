#!/usr/bin/env node

const COMMANDS = [
  "install",
  "status",
  "query",
  "inspect",
  "uninstall",
  "extract",
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

function getHookScriptCode(eventName: string): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const distDir = join(currentDir, "..").replace(/\\/g, "/");

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

function installHooks(cwd: string) {
  const claudePresent = existsSync(join(cwd, ".claude"));
  const codexPresent = existsSync(join(cwd, ".codex"));

  // Always install Claude Code hooks if .claude/ exists (or as default).
  // Install Codex hooks if .codex/ is already present (explicit Codex repo).
  // Both can coexist in the same repo — neither blocks the other.
  const installedAgents: string[] = [];

  if (claudePresent || !codexPresent) {
    installClaudeCodeHooks(cwd);
    installedAgents.push("claude-code");
  }

  if (codexPresent) {
    installCodexHooks(cwd);
    installedAgents.push("codex");
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
      return { exitCode: 0, stdout: `dev-mem hooks installed (agents: ${agents.join(", ")})\n`, stderr: "" };
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
      await runExtraction({ projectRoot: cwd, sessionId });
      return { exitCode: 0, stdout: "Extraction complete\n", stderr: "" };
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
