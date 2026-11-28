import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function sessionStatePath(projectRoot: string, sessionId: string, suffix: string): string {
  const dir = join(projectRoot, ".dev-mem", "sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${encodeURIComponent(sessionId)}.${suffix}.json`);
}

function filterUnseenById<T>(
  projectRoot: string,
  sessionId: string,
  suffix: string,
  items: T[],
  getId: (item: T) => string,
): T[] {
  if (!sessionId || items.length === 0) return items;
  try {
    const path = sessionStatePath(projectRoot, sessionId, suffix);
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
    for (const item of items) {
      const id = getId(item);
      if (!seenSet.has(id)) {
        seenSet.add(id);
        unseen.push(item);
      }
    }
    if (unseen.length > 0) {
      writeFileSync(path, JSON.stringify([...seenSet]), "utf8");
    }
    return unseen;
  } catch {
    return items;
  }
}

/**
 * Returns true if any nodes have already been injected during `sessionId`.
 */
export function hasSessionInjections(projectRoot: string, sessionId: string): boolean {
  if (!sessionId) return false;
  try {
    return existsSync(join(projectRoot, ".dev-mem", "sessions", `${encodeURIComponent(sessionId)}.injected.json`));
  } catch {
    return false;
  }
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
  return filterUnseenById(projectRoot, sessionId, "injected", nodes, (n) => n.id);
}

/**
 * Filters regression warning matches down to FailedApproach node IDs not yet
 * surfaced during `sessionId`, stopping repeated edit-hook warning spam.
 */
export function filterUnseenWarnings<T extends { node: { id: string } }>(
  projectRoot: string,
  sessionId: string,
  matches: T[],
): T[] {
  return filterUnseenById(projectRoot, sessionId, "warnings", matches, (m) => m.node.id);
}
