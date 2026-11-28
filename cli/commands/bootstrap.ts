import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { bootstrapProject, type BootstrapResult } from "../../core/bootstrap/index.js";

/**
 * Encodes a project root path using Claude Code's project folder naming convention
 * (separators & colons mapped to `-`), then checks ~/.claude/projects/<encoded>/memory/*.md
 * plus case-insensitive/basename fallbacks.
 */
export function findClaudeMemoryFiles(projectRoot: string, home = homedir()): string[] {
  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  const resolved = resolve(projectRoot);
  const encodedExact = resolved.replace(/[:\\/]/g, "-").toLowerCase();
  const baseSlug = basename(resolved).toLowerCase();

  const matches: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryLower = entry.toLowerCase();
    const isMatch =
      entryLower === encodedExact ||
      entryLower.endsWith(`-${baseSlug}`) ||
      entryLower === baseSlug;
    if (!isMatch) continue;

    const memDir = join(projectsDir, entry, "memory");
    if (!existsSync(memDir)) continue;
    try {
      for (const file of readdirSync(memDir)) {
        if (file.toLowerCase().endsWith(".md")) {
          matches.push(join(memDir, file));
        }
      }
    } catch {
      // ignore unreadable memory dirs
    }
  }
  return matches;
}

export async function runBootstrap(cwd: string, args: string[] = []): Promise<BootstrapResult> {
  const fromFiles: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      fromFiles.push(args[i + 1]);
      i++;
    }
  }
  if (args.includes("--claude-memory")) {
    fromFiles.push(...findClaudeMemoryFiles(cwd));
  }
  return bootstrapProject({ projectRoot: cwd, fromFiles });
}
