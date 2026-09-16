import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Local data directory at the project root (spec §3.3). */
export const DEV_MEM_DIR = ".dev-mem";
export const GRAPH_DB_FILENAME = "graph.sqlite";
export const EVENTS_LOG_FILENAME = "events.jsonl";
export const GITIGNORE_ENTRY = ".dev-mem/";

export function getDevMemDir(projectRoot: string): string {
  return join(projectRoot, DEV_MEM_DIR);
}

export function getGraphDbPath(projectRoot: string): string {
  return join(getDevMemDir(projectRoot), GRAPH_DB_FILENAME);
}

export function getEventsLogPath(projectRoot: string): string {
  return join(getDevMemDir(projectRoot), EVENTS_LOG_FILENAME);
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
  const alreadyIgnored = lines.some(
    (line) => line.trim() === GITIGNORE_ENTRY || line.trim() === DEV_MEM_DIR,
  );
  if (alreadyIgnored) {
    return;
  }

  const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  writeFileSync(gitignorePath, `${current}${suffix}${GITIGNORE_ENTRY}\n`, "utf8");
}
