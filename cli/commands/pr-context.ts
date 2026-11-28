import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runPrContext } from "../../core/ci/pr-context.js";
import type { CommandResult } from "./manage.js";

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export function runPrContextCommand(cwd: string, args: string[]): CommandResult {
  const filesRaw = parseFlagValue(args, "--files");
  const changedFiles = filesRaw
    ? filesRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const baseRef = parseFlagValue(args, "--base");
  const headRef = parseFlagValue(args, "--head");
  const title = parseFlagValue(args, "--title");
  const outPath = parseFlagValue(args, "--out");
  const verifyOnMerge = args.includes("--verify-on-merge");
  const jsonMode = args.includes("--json");

  const res = runPrContext(cwd, {
    changedFiles,
    baseRef,
    headRef,
    title,
    verifyOnMerge,
  });

  if (outPath) {
    const abs = resolve(cwd, outPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, res.markdown, "utf8");
  }

  if (jsonMode) {
    return {
      exitCode: 0,
      stdout:
        JSON.stringify(
          {
            changedFiles: res.changedFiles,
            warnings: res.regressionWarnings.length,
            relevantNodes: res.relevantNodes.length,
            verifiedNodeIds: res.verifiedNodeIds,
            hasContent: res.hasContent,
          },
          null,
          2,
        ) + "\n",
      stderr: "",
    };
  }

  if (!res.hasContent) {
    return {
      exitCode: 0,
      stdout: "No relevant Dev-Mem warnings or context for changed files.\n",
      stderr: "",
    };
  }

  return { exitCode: 0, stdout: res.markdown, stderr: "" };
}
