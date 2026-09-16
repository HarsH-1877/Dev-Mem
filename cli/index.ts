#!/usr/bin/env node

const COMMANDS = [
  "install",
  "status",
  "query",
  "inspect",
  "uninstall",
] as const;

type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { ensureLocalDataDir, getEventsLogPath } from "../core/local-data.js";
import { GraphStore } from "../core/graph/index.js";

function getHookScriptCode(eventName: string): string {
  // Using a dynamic import so that it works whether dev-mem is linked or installed
  return `import { readFileSync } from "node:fs";
import { DeterministicCapture } from "dev-mem/capture";

const inputStr = readFileSync(0, "utf-8");
if (!inputStr) process.exit(0);
const payload = JSON.parse(inputStr);
const cwd = payload.cwd || process.cwd();

const capture = new DeterministicCapture({
  projectRoot: cwd,
  agent: "claude-code",
  sessionId: payload.session_id,
});

if ("${eventName}" === "SessionStart") {
  capture.startSession();
  capture.captureGit();
} else if ("${eventName}" === "PostToolUse") {
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};
  const toolResponse = payload.tool_response || {};
  
  let command = toolName;
  let args = [];
  let stdout, stderr;
  
  if (toolName === "Bash" || toolName === "PowerShell") {
    command = toolInput.command || toolName;
    stdout = toolResponse.stdout;
    stderr = toolResponse.stderr;
  } else if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
    args = [toolInput.file_path];
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
} else if ("${eventName}" === "Stop") {
  capture.captureGit();
} else if ("${eventName}" === "SessionEnd") {
  capture.endSession();
}

process.exit(0);
`;
}

function installHooks(cwd: string) {
  const claudeDir = join(cwd, ".claude");
  if (!existsSync(claudeDir)) {
    throw new Error("No .claude directory found. Run claude code first.");
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
  ensureLocalDataDir(cwd);
}

function uninstallHooks(cwd: string, purge: boolean) {
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

  const hooksDir = join(claudeDir, "hooks");
  if (existsSync(hooksDir)) {
    const events = ["SessionStart", "PostToolUse", "Stop", "SessionEnd"];
    for (const event of events) {
      const scriptName = `dev-mem-${event.toLowerCase().replace(/([A-Z])/g, '-$1').replace(/^-/, '')}.js`;
      const scriptPath = join(hooksDir, scriptName);
      if (existsSync(scriptPath)) {
        rmSync(scriptPath);
      }
    }
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

export function runCli(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
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
      installHooks(cwd);
      return { exitCode: 0, stdout: "dev-mem hooks installed\n", stderr: "" };
    } else if (command === "status") {
      const output = runStatus(cwd);
      return { exitCode: 0, stdout: output + "\n", stderr: "" };
    } else if (command === "uninstall") {
      const purge = args.includes("--purge");
      uninstallHooks(cwd, purge);
      return { exitCode: 0, stdout: "dev-mem hooks uninstalled\n", stderr: "" };
    }
  } catch (e: any) {
    return { exitCode: 1, stdout: "", stderr: e.message + "\n" };
  }

  // Full command logic is a later milestone. Surface exists now (spec §3.4).
  return { exitCode: 0, stdout: "not yet implemented\n", stderr: "" };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli/index.ts") ||
    process.argv[1].endsWith("cli\\index.ts") ||
    process.argv[1].endsWith("cli/index.js") ||
    process.argv[1].endsWith("cli\\index.js") ||
    process.argv[1].endsWith("dev-mem"));

if (isDirectRun) {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.exitCode);
}
