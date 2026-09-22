import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_EXTRACTION_EVENT_THRESHOLD = 10;

/** Invalid or unsafe configuration deliberately falls back to the documented default. */
export function getExtractionEventThreshold(projectRoot: string): number {
  const configPath = join(projectRoot, ".dev-mem", "config.yml");
  if (!existsSync(configPath)) return DEFAULT_EXTRACTION_EVENT_THRESHOLD;
  try {
    const content = readFileSync(configPath, "utf8");
    const match = content.match(/^\s*extraction_event_threshold\s*:\s*(\S+)\s*$/m);
    if (!match) return DEFAULT_EXTRACTION_EVENT_THRESHOLD;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) return value;
    console.error(`[dev-mem/cursor] Invalid extraction_event_threshold in ${configPath}; using ${DEFAULT_EXTRACTION_EVENT_THRESHOLD}`);
  } catch (error) {
    console.error(`[dev-mem/cursor] Unable to read checkpoint config; using ${DEFAULT_EXTRACTION_EVENT_THRESHOLD}: ${(error as Error).message}`);
  }
  return DEFAULT_EXTRACTION_EVENT_THRESHOLD;
}
