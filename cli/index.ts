#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pruneExtractedEvents } from "../core/capture/compact.js";
import { syncSharedGraph } from "../core/sync/index.js";
import { getBanner } from "./banner.js";
import { installHooks, uninstallHooks, findStaleHooks } from "./commands/install.js";
import { runStatus, runDoctor } from "./commands/diagnostics.js";
import { runQuery, runInspect } from "./commands/inspect.js";
import { extractOnce, runWrap } from "./commands/extract.js";
import { runBootstrap } from "./commands/bootstrap.js";
import { runInit } from "./commands/init.js";

const COMMANDS = [
  "init",
  "install",
  "status",
  "query",
  "inspect",
  "uninstall",
  "extract",
  "wrap",
  "doctor",
  "prune",
  "sync",
  "mcp",
  "bootstrap",
] as const;

type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

export { findStaleHooks, runDoctor };

export function runPrune(cwd: string): { removedEvents: number; keptEvents: number } {
  return pruneExtractedEvents(cwd);
}

export function runSync(cwd: string): { importedNodes: number; updatedNodes: number; exportedNodes: number } {
  return syncSharedGraph(cwd);
}

/** Reads the version from package.json (works from both cli/ source and dist/cli/ build). */
function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), "utf8"));
      if (pkg?.name === "dev-memo" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "unknown";
}

function helpText(): string {
  return [
    getBanner(),
    "",
    `Usage: dev-memo <${COMMANDS.join("|")}>`,
    "",
    "Commands:",
    "  init [agent...]      One-step setup: install hooks, wire MCP, verify backend, and bootstrap starter memory",
    "  install [agent...]   Install hooks (claude-code, codex, cursor, opencode); auto-detects if omitted",
    "  bootstrap [--from f] Mine git reverts & instruction files into starter memory ($0 LLM cost)",
    "  status               Show graph and capture status",
    "  doctor [--live]      Check git, hooks, install path and LLM configuration",
    "  query \"<task>\"       Show context relevant to a task",
    "  inspect <node-id>    Show full details of a graph node",
    "  extract <sessionId>  Run knowledge extraction for a session",
    "  prune                Remove events from already-extracted sessions from events.jsonl",
    "  sync                 Sync active/verified nodes with git-friendly .dev-mem/shared.jsonl",
    "  wrap <command...>    Run a command, then flush captured events",
    "  mcp                  Run the stdio Model Context Protocol (MCP) server",
    "  uninstall [--purge]  Remove hooks (--purge also deletes .dev-mem/)",
    "",
    "Options:",
    "  -v, --version        Print version",
    "  -h, --help           Print this help",
    "",
  ].join("\n");
}

export async function runCli(
  argv: string[],
  options: { cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [command, ...args] = argv;

  if (command === "--version" || command === "-v") {
    return { exitCode: 0, stdout: readPackageVersion() + "\n", stderr: "" };
  }

  if (command === "--help" || command === "-h") {
    return { exitCode: 0, stdout: helpText(), stderr: "" };
  }

  if (!command) {
    return { exitCode: 0, stdout: helpText(), stderr: "" };
  }

  if (!isCommand(command)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown command: ${command}\nUsage: dev-memo <${COMMANDS.join("|")}>\n`,
    };
  }

  const cwd = options.cwd ?? process.cwd();

  try {
    if (command === "init") {
      return await runInit(cwd, args);
    } else if (command === "install") {
      const { installedAgents: agents, defaultedToClaude } = installHooks(cwd, args);
      let out = `${getBanner()}\n\ndev-memo hooks installed (agents: ${agents.join(", ")})\n`;
      if (defaultedToClaude) {
        out += `\n[Notice]: No agent configuration folders were detected, so dev-memo defaulted to claude-code.\nIf you are using a different agent, specify it explicitly:\n  dev-memo install codex\n  dev-memo install cursor\n`;
      }
      if (agents.includes("cursor")) {
        out += `\n[Notice for Cursor]: Cursor CLI lacks a reliable SessionEnd event.\nDev-Memo uses an N-accumulated-events trigger (default 10) instead.\nFor a perfect flush when exiting, run your agent via: dev-memo wrap cursor-agent <args>\n`;
      }
      return { exitCode: 0, stdout: out, stderr: "" };
    } else if (command === "status") {
      return { exitCode: 0, stdout: runStatus(cwd) + "\n", stderr: "" };
    } else if (command === "doctor") {
      const r = await runDoctor(cwd, { live: args.includes("--live") });
      return { stdout: r.lines.join("\n") + "\n", stderr: "", exitCode: r.ok ? 0 : 1 };
    } else if (command === "uninstall") {
      uninstallHooks(cwd, args.includes("--purge"));
      return { exitCode: 0, stdout: "dev-memo hooks uninstalled\n", stderr: "" };
    } else if (command === "extract") {
      const sessionId = args[0];
      if (!sessionId) {
        return { exitCode: 1, stdout: "", stderr: "Usage: dev-memo extract <sessionId>\n" };
      }
      const result = await extractOnce(cwd, sessionId);
      if (result.skipped) {
        return { exitCode: result.success ? 0 : 1, stdout: "Extraction skipped\n", stderr: "" };
      }
      if (!result.success) {
        return { exitCode: 1, stdout: "", stderr: `Extraction failed for session ${sessionId} (see messages above)\n` };
      }
      return { exitCode: 0, stdout: "Extraction complete\n", stderr: "" };
    } else if (command === "wrap") {
      return await runWrap(cwd, args);
    } else if (command === "query") {
      return runQuery(cwd, args[0]);
    } else if (command === "inspect") {
      return runInspect(cwd, args[0]);
    } else if (command === "prune") {
      const { removedEvents, keptEvents } = runPrune(cwd);
      return {
        exitCode: 0,
        stdout: `Pruned ${removedEvents} extracted event(s); ${keptEvents} active event(s) kept.\n`,
        stderr: "",
      };
    } else if (command === "sync") {
      const res = runSync(cwd);
      return {
        exitCode: 0,
        stdout: `Synced .dev-mem/shared.jsonl (imported: ${res.importedNodes}, updated: ${res.updatedNodes}, exported: ${res.exportedNodes} active/verified nodes).\n`,
        stderr: "",
      };
    } else if (command === "mcp") {
      const { startMcpStdioServer } = await import("../core/mcp/server.js");
      await startMcpStdioServer(cwd);
      return { exitCode: 0, stdout: "", stderr: "" };
    } else if (command === "bootstrap") {
      const res = await runBootstrap(cwd, args);
      const total = res.revertsAdded + res.rulesAdded;
      return {
        exitCode: 0,
        stdout: `Bootstrapped ${total} memory node(s) (reverts: ${res.revertsAdded}, rules: ${res.rulesAdded}, skipped duplicates: ${res.skippedDuplicates}).\n`,
        stderr: "",
      };
    }
  } catch (e: any) {
    return { exitCode: 1, stdout: "", stderr: e.message + "\n" };
  }

  return { exitCode: 1, stdout: "", stderr: `Command "${command}" is not yet implemented.\n` };
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("cli/index.js") ||
    process.argv[1].endsWith("cli\\index.js") ||
    process.argv[1].endsWith("dev-mem") ||
    process.argv[1].endsWith("dev-memo"));

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((result) => {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
