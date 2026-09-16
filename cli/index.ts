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

export function runCli(argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const [command] = argv;

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
