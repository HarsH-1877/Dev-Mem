import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireExtractionLock, markExtractionComplete } from "../../core/extraction-lock.js";
import { pruneExtractedEvents } from "../../core/capture/compact.js";
import { runExtraction } from "../../core/extraction/index.js";
import { EventLog } from "../../core/capture/log.js";

export async function extractOnce(cwd: string, sessionId: string): Promise<{ skipped: boolean; success: boolean }> {
  let release: (() => void) | null;
  try {
    release = acquireExtractionLock(cwd, sessionId);
  } catch (error) {
    console.error(`[dev-memo] Unable to prepare extraction lock for ${sessionId}: ${(error as Error).message}`);
    return { skipped: true, success: false };
  }
  if (!release) {
    console.error(`[dev-memo] Extraction already running or complete for session ${sessionId}; skipping duplicate trigger`);
    return { skipped: true, success: true };
  }
  try {
    const result = await runExtraction({ projectRoot: cwd, sessionId });
    if (result.success) {
      markExtractionComplete(cwd, sessionId);
      pruneExtractedEvents(cwd);
    }
    return { skipped: false, success: result.success };
  } finally {
    release();
  }
}

export function runWrap(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (args.length === 0) {
    return Promise.resolve({ exitCode: 1, stdout: "", stderr: "Usage: dev-memo wrap <command> [args...]\n" });
  }
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(args[0], args.slice(1), { stdio: "inherit", shell: isWin });

    child.on("close", async (code) => {
      try {
        const log = new EventLog({ persistPath: join(cwd, ".dev-mem", "events.jsonl") });
        const events = log.getEvents();
        if (events.length > 0) {
          const lastSessionId = events[events.length - 1].session_id;
          if (lastSessionId) {
            process.stdout.write(
              `\n[dev-memo] Wrapping complete. Flushing remaining events for session ${lastSessionId}...\n`,
            );
            await extractOnce(cwd, lastSessionId);
          }
        }
      } catch (e: any) {
        process.stderr.write(`[dev-memo] Wrap flush error: ${e.message}\n`);
      }
      resolve({ exitCode: code ?? 0, stdout: "", stderr: "" });
    });
  });
}
