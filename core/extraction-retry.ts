import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog } from "./capture/log.js";
import { extractionStatePath, isExtractionComplete } from "./extraction-lock.js";

/** Total re-triggers allowed per session after the original attempt failed or never ran. */
export const MAX_RETRY_ATTEMPTS = 3;
/** Cap on re-triggers per session start so one start can't fan out a burst of LLM calls. */
export const MAX_RETRIES_PER_START = 2;

function readAttempts(projectRoot: string, sessionId: string): number {
  try {
    const n = Number(readFileSync(extractionStatePath(projectRoot, sessionId, "attempts"), "utf8"));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Sessions that ended, captured something, and were never successfully extracted.
 * Sessions without a session_end are skipped: they may still be running in another
 * window, and extracting them early would lose their later events.
 */
export function findPendingSessions(projectRoot: string, currentSessionId: string): string[] {
  const logPath = join(projectRoot, ".dev-mem", "events.jsonl");
  if (!existsSync(logPath)) return [];

  const counts = new Map<string, number>();
  const ended = new Set<string>();
  for (const event of new EventLog({ persistPath: logPath }).getEvents()) {
    counts.set(event.session_id, (counts.get(event.session_id) ?? 0) + 1);
    if (event.type === "session_end") ended.add(event.session_id);
  }

  return [...ended].filter(
    (id) =>
      id !== currentSessionId &&
      (counts.get(id) ?? 0) > 2 && // more than just session_start + session_end
      !isExtractionComplete(projectRoot, id) &&
      readAttempts(projectRoot, id) < MAX_RETRY_ATTEMPTS,
  );
}

function spawnDetachedExtraction(projectRoot: string, sessionId: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(here, "../cli/index.js");
  const child = spawn(process.execPath, [cliPath, "extract", sessionId], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Re-triggers extraction for sessions whose earlier attempt failed (e.g. LLM 503) or
 * never ran. Safe to call on every session start: it never throws, is capped, and the
 * extraction lock makes duplicate triggers harmless. Returns the sessions it triggered.
 */
export function retryPendingExtractions(
  projectRoot: string,
  currentSessionId: string,
  spawnExtraction: (sessionId: string) => void = (id) => spawnDetachedExtraction(projectRoot, id),
): string[] {
  const triggered: string[] = [];
  try {
    for (const sessionId of findPendingSessions(projectRoot, currentSessionId).slice(0, MAX_RETRIES_PER_START)) {
      writeFileSync(extractionStatePath(projectRoot, sessionId, "attempts"), String(readAttempts(projectRoot, sessionId) + 1), "utf8");
      spawnExtraction(sessionId);
      triggered.push(sessionId);
    }
  } catch (error) {
    console.error(`[dev-mem] Skipping extraction retry: ${(error as Error).message}`);
  }
  return triggered;
}
