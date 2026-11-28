import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GraphStore } from "../graph/index.js";
import {
  ensureLocalDataDir,
  getDevMemDir,
  getExtractionLogPath,
  getGraphDbPath,
  getTelemetryLogPath,
  type ExtractionLogEntry,
} from "../local-data.js";

export type TelemetryEventKind =
  | "injection"
  | "regression_warning"
  | "mcp_query"
  | "verification";

export interface TelemetryEvent {
  timestamp: string;
  kind: TelemetryEventKind;
  session_id?: string;
  count?: number;
  agent?: string;
}

export interface DevMemStats {
  totalNodes: number;
  verifiedNodes: number;
  activeNodes: number;
  observedNodes: number;
  staleNodes: number;
  supersededNodes: number;
  groundedNodes: number;
  edgeCount: number;
  nodesByType: Record<string, number>;
  sessionsAssisted: number;
  totalInjections: number;
  preventedRegressions: number;
  mcpQueries: number;
  extractions: {
    total: number;
    succeeded: number;
    failed: number;
  };
}

export function recordTelemetryEvent(
  projectRoot: string,
  event: Omit<TelemetryEvent, "timestamp"> & { timestamp?: string },
): void {
  try {
    ensureLocalDataDir(projectRoot);
    const full: TelemetryEvent = {
      timestamp: event.timestamp ?? new Date().toISOString(),
      kind: event.kind,
      ...(event.session_id ? { session_id: event.session_id } : {}),
      ...(typeof event.count === "number" ? { count: event.count } : {}),
      ...(event.agent ? { agent: event.agent } : {}),
    };
    appendFileSync(getTelemetryLogPath(projectRoot), JSON.stringify(full) + "\n", "utf8");
  } catch {
    // Best-effort telemetry never throws
  }
}

export function readTelemetryEvents(projectRoot: string): TelemetryEvent[] {
  const logPath = getTelemetryLogPath(projectRoot);
  if (!existsSync(logPath)) return [];
  try {
    return readFileSync(logPath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.kind === "string") {
            return [parsed as TelemetryEvent];
          }
        } catch {
          // ignore malformed line
        }
        return [];
      });
  } catch {
    return [];
  }
}

function readExtractionHistory(projectRoot: string): ExtractionLogEntry[] {
  const path = getExtractionLogPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.session_id === "string") {
            return [parsed as ExtractionLogEntry];
          }
        } catch {
          // ignore corrupt lines
        }
        return [];
      });
  } catch {
    return [];
  }
}

function scanSessionFiles(projectRoot: string): {
  sessions: Set<string>;
  injectedIdsCount: number;
  warningIdsCount: number;
} {
  const sessions = new Set<string>();
  let injectedIdsCount = 0;
  let warningIdsCount = 0;

  const sessionsDir = join(getDevMemDir(projectRoot), "sessions");
  if (!existsSync(sessionsDir)) {
    return { sessions, injectedIdsCount, warningIdsCount };
  }

  try {
    for (const file of readdirSync(sessionsDir)) {
      if (file.endsWith(".injected.json")) {
        sessions.add(file.slice(0, -".injected.json".length));
        try {
          const parsed = JSON.parse(readFileSync(join(sessionsDir, file), "utf8"));
          if (Array.isArray(parsed)) injectedIdsCount += parsed.length;
        } catch {}
      } else if (file.endsWith(".warnings.json")) {
        sessions.add(file.slice(0, -".warnings.json".length));
        try {
          const parsed = JSON.parse(readFileSync(join(sessionsDir, file), "utf8"));
          if (Array.isArray(parsed)) warningIdsCount += parsed.length;
        } catch {}
      }
    }
  } catch {
    // ignore read failure
  }

  return { sessions, injectedIdsCount, warningIdsCount };
}

/**
 * Computes live engineering memory statistics directly from local SQLite,
 * session deduplication artifacts, extraction logs, and telemetry events.
 */
export function collectStats(projectRoot: string): DevMemStats {
  const nodesByType: Record<string, number> = {};
  const nodesByState: Record<string, number> = {};
  let totalNodes = 0;
  let groundedNodes = 0;
  let edgeCount = 0;

  if (existsSync(getGraphDbPath(projectRoot))) {
    const store = new GraphStore({ projectRoot });
    try {
      const nodes = store.queryAllNodes();
      totalNodes = nodes.length;
      const seenEdges = new Set<string>();
      for (const n of nodes) {
        nodesByType[n.type] = (nodesByType[n.type] ?? 0) + 1;
        nodesByState[n.lifecycle_state] = (nodesByState[n.lifecycle_state] ?? 0) + 1;
        if (n.evidence.grounded !== false) groundedNodes++;
        for (const e of store.listEdges(n.id)) {
          seenEdges.add(e.id);
        }
      }
      edgeCount = seenEdges.size;
    } finally {
      store.close();
    }
  }

  const telemetry = readTelemetryEvents(projectRoot);
  const extractionsList = readExtractionHistory(projectRoot);
  const sessionScan = scanSessionFiles(projectRoot);

  let telemetryInjections = 0;
  let telemetryWarnings = 0;
  let mcpQueries = 0;

  for (const ev of telemetry) {
    if (ev.session_id) sessionScan.sessions.add(encodeURIComponent(ev.session_id));
    if (ev.kind === "injection") telemetryInjections += ev.count ?? 1;
    else if (ev.kind === "regression_warning") telemetryWarnings += ev.count ?? 1;
    else if (ev.kind === "mcp_query") mcpQueries += ev.count ?? 1;
  }

  for (const ex of extractionsList) {
    sessionScan.sessions.add(encodeURIComponent(ex.session_id));
  }

  const succeeded = extractionsList.filter((e) => e.success).length;
  const failed = extractionsList.length - succeeded;

  return {
    totalNodes,
    verifiedNodes: nodesByState.verified ?? 0,
    activeNodes: nodesByState.active ?? 0,
    observedNodes: nodesByState.observed ?? 0,
    staleNodes: nodesByState.stale ?? 0,
    supersededNodes: nodesByState.superseded ?? 0,
    groundedNodes,
    edgeCount,
    nodesByType,
    sessionsAssisted: sessionScan.sessions.size,
    totalInjections: Math.max(telemetryInjections, sessionScan.injectedIdsCount),
    preventedRegressions: Math.max(telemetryWarnings, sessionScan.warningIdsCount),
    mcpQueries,
    extractions: {
      total: extractionsList.length,
      succeeded,
      failed,
    },
  };
}
