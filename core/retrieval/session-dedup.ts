import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function seenFilePath(projectRoot: string, sessionId: string): string {
  const dir = join(projectRoot, ".dev-mem", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${encodeURIComponent(sessionId)}.injected.json`);
}

/**
 * Filters a candidate list of nodes down to those not yet injected during
 * `sessionId`, and records the newly selected node IDs as seen.
 */
export function filterUnseenNodes<T extends { id: string }>(
  projectRoot: string,
  sessionId: string,
  nodes: T[],
): T[] {
  if (!sessionId || nodes.length === 0) return nodes;
  try {
    const path = seenFilePath(projectRoot, sessionId);
    let seenIds: string[] = [];
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (Array.isArray(parsed)) seenIds = parsed;
      } catch {
        seenIds = [];
      }
    }
    const seenSet = new Set(seenIds);
    const unseen: T[] = [];
    for (const node of nodes) {
      if (!seenSet.has(node.id)) {
        seenSet.add(node.id);
        unseen.push(node);
      }
    }
    if (unseen.length > 0) {
      writeFileSync(path, JSON.stringify([...seenSet]), "utf8");
    }
    return unseen;
  } catch {
    return nodes;
  }
}
