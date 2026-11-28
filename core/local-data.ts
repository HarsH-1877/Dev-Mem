import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Local data directory at the project root (spec §3.3). */
export const DEV_MEM_DIR = ".dev-mem";
export const GRAPH_DB_FILENAME = "graph.sqlite";
export const EVENTS_LOG_FILENAME = "events.jsonl";
export const SHARED_GRAPH_FILENAME = "shared.jsonl";
export const MEMORY_MD_FILENAME = "MEMORY.md";
export const EXTRACTION_LOG_FILENAME = "extraction.log";
export const GITIGNORE_ENTRY = ".dev-mem/*\n!.dev-mem/shared.jsonl\n!.dev-mem/MEMORY.md";

export function getDevMemDir(projectRoot: string): string {
  return join(projectRoot, DEV_MEM_DIR);
}

export function getGraphDbPath(projectRoot: string): string {
  return join(getDevMemDir(projectRoot), GRAPH_DB_FILENAME);
}

export function getEventsLogPath(projectRoot: string): string {
  return join(getDevMemDir(projectRoot), EVENTS_LOG_FILENAME);
}

export function getSharedGraphPath(projectRoot: string): string {
  return join(getDevMemDir(projectRoot), SHARED_GRAPH_FILENAME);
}

export function getMemoryMarkdownPath(projectRoot: string): string {
  return join(getDevMemDir(projectRoot), MEMORY_MD_FILENAME);
}

export function getExtractionLogPath(projectRoot: string): string {
  return join(getDevMemDir(projectRoot), EXTRACTION_LOG_FILENAME);
}

export interface ExtractionLogEntry {
  timestamp: string;
  session_id: string;
  provider: string;
  success: boolean;
  nodes_created: number;
  error?: string;
}

export function appendExtractionLog(projectRoot: string, entry: ExtractionLogEntry): void {
  try {
    ensureLocalDataDir(projectRoot);
    appendFileSync(getExtractionLogPath(projectRoot), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Never throw from diagnostic logging
  }
}

export function readLastExtractionLog(projectRoot: string): ExtractionLogEntry | null {
  try {
    const logPath = getExtractionLogPath(projectRoot);
    if (!existsSync(logPath)) return null;
    const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object" && typeof parsed.session_id === "string") {
          return parsed as ExtractionLogEntry;
        }
      } catch {
        // skip corrupt line
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Creates `.dev-mem/` if missing and ensures `.dev-mem/` is listed in the
 * project's `.gitignore` (spec §3.3).
 */
export function ensureLocalDataDir(projectRoot: string): string {
  const dir = getDevMemDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  ensureDevMemGitignore(projectRoot);
  return dir;
}

export function ensureDevMemGitignore(projectRoot: string): void {
  const gitignorePath = join(projectRoot, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_ENTRY}\n`, "utf8");
    return;
  }

  const current = readFileSync(gitignorePath, "utf8");
  const lines = current.split(/\r?\n/);

  // If already allowing shared.jsonl & MEMORY.md with wildcard ignore, we are done
  const hasWildcard = lines.some((line) => line.trim() === ".dev-mem/*");
  const hasUnignoreShared = lines.some((line) => line.trim() === "!.dev-mem/shared.jsonl");
  const hasUnignoreMemory = lines.some((line) => line.trim() === "!.dev-mem/MEMORY.md");
  if (hasWildcard && hasUnignoreShared && hasUnignoreMemory) {
    return;
  }

  if (hasWildcard && hasUnignoreShared && !hasUnignoreMemory) {
    const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
    writeFileSync(gitignorePath, `${current}${suffix}!.dev-mem/MEMORY.md\n`, "utf8");
    return;
  }

  // If old-style .dev-mem/ or .dev-mem exists, replace it so shared.jsonl & MEMORY.md can be committed
  const hasOldStyle = lines.some(
    (line) => line.trim() === ".dev-mem/" || line.trim() === ".dev-mem",
  );

  if (hasOldStyle) {
    const newLines = lines.flatMap((line) => {
      const trimmed = line.trim();
      if (trimmed === ".dev-mem/" || trimmed === ".dev-mem") {
        return [".dev-mem/*", "!.dev-mem/shared.jsonl", "!.dev-mem/MEMORY.md"];
      }
      return [line];
    });
    writeFileSync(gitignorePath, newLines.join("\n") + (current.endsWith("\n") ? "\n" : ""), "utf8");
    return;
  }

  const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  writeFileSync(gitignorePath, `${current}${suffix}${GITIGNORE_ENTRY}\n`, "utf8");
}

