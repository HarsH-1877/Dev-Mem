import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STALE_LOCK_MS = 5 * 60 * 1000;

function statePath(projectRoot: string, sessionId: string, suffix: string): string {
  const dir = join(projectRoot, ".dev-mem", "extractions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${encodeURIComponent(sessionId)}.${suffix}`);
}

/** Returns false when another hook already completed or is extracting this session. */
export function acquireExtractionLock(projectRoot: string, sessionId: string): (() => void) | null {
  const done = statePath(projectRoot, sessionId, "done");
  if (existsSync(done)) return null;
  const lock = statePath(projectRoot, sessionId, "lock");
  try {
    writeFileSync(lock, String(Date.now()), { flag: "wx" });
  } catch {
    try {
      const age = Date.now() - Number(readFileSync(lock, "utf8"));
      if (Number.isFinite(age) && age > STALE_LOCK_MS) {
        rmSync(lock, { force: true });
        writeFileSync(lock, String(Date.now()), { flag: "wx" });
      } else return null;
    } catch { return null; }
  }
  return () => rmSync(lock, { force: true });
}

export function markExtractionComplete(projectRoot: string, sessionId: string): void {
  writeFileSync(statePath(projectRoot, sessionId, "done"), new Date().toISOString(), "utf8");
}
