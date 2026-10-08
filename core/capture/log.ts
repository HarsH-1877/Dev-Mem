import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CaptureEvent } from "./events.js";

/**
 * Append-only structured event log. Extraction (later milestone) will consume
 * this; capture itself never calls an LLM.
 */
export class EventLog {
  private readonly events: CaptureEvent[] = [];
  private readonly persistPath?: string;
  /** True when the file ends mid-line (e.g. process killed mid-write). */
  private needsLeadingNewline = false;

  constructor(options: { persistPath?: string } = {}) {
    this.persistPath = options.persistPath;
    if (this.persistPath && existsSync(this.persistPath)) {
      const raw = readFileSync(this.persistPath, "utf8");
      this.needsLeadingNewline = raw.length > 0 && !raw.endsWith("\n");
      const text = raw.trim();
      if (text !== "") {
        for (const [index, line] of text.split("\n").entries()) {
          try {
            this.events.push(JSON.parse(line) as CaptureEvent);
          } catch (error) {
            // One bad line must not permanently disable capture. Skip it, but say so.
            console.error(`[dev-mem] Skipping corrupt event log line ${index + 1}: ${(error as Error).message}`);
          }
        }
      }
    }
  }

  append<T extends CaptureEvent>(event: T): T {
    this.events.push(event);
    if (this.persistPath) {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const prefix = this.needsLeadingNewline ? "\n" : "";
      appendFileSync(this.persistPath, `${prefix}${JSON.stringify(event)}\n`, "utf8");
      this.needsLeadingNewline = false;
    }
    return event;
  }

  getEvents(): CaptureEvent[] {
    return [...this.events];
  }
}

export function newEventId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
