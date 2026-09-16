import { ensureLocalDataDir, getEventsLogPath } from "../local-data.js";
import type {
  CaptureEvent,
  FileTouchAction,
  FileTouchEvent,
  GitSnapshotEvent,
  SessionEndEvent,
  SessionStartEvent,
  ToolCallEvent,
} from "./events.js";
import { collectGitSnapshot } from "./git.js";
import { EventLog, newEventId, nowIso } from "./log.js";

export interface DeterministicCaptureOptions {
  projectRoot: string;
  agent: string;
  sessionId?: string;
  /** In-memory only when true (tests). Default persists to `.dev-mem/events.jsonl`. */
  ephemeral?: boolean;
  eventLog?: EventLog;
}

export interface ToolCallInput {
  command: string;
  args?: string[];
  exit_code: number;
  stdout?: string;
  stderr?: string;
  test_pass?: boolean;
}

/**
 * Deterministic capture layer (spec §7.1). Zero LLM calls.
 * Independently testable — does not import the graph store.
 */
export class DeterministicCapture {
  readonly projectRoot: string;
  readonly agent: string;
  readonly sessionId: string;
  private readonly log: EventLog;
  private sessionOpen = false;

  constructor(options: DeterministicCaptureOptions) {
    this.projectRoot = options.projectRoot;
    this.agent = options.agent;
    this.sessionId = options.sessionId ?? newEventId();

    if (options.eventLog) {
      this.log = options.eventLog;
    } else if (options.ephemeral) {
      this.log = new EventLog();
    } else {
      ensureLocalDataDir(options.projectRoot);
      this.log = new EventLog({
        persistPath: getEventsLogPath(options.projectRoot),
      });
    }
  }

  startSession(): SessionStartEvent {
    this.sessionOpen = true;
    return this.log.append({
      type: "session_start",
      id: newEventId(),
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent: this.agent,
      project_root: this.projectRoot,
    });
  }

  endSession(): SessionEndEvent {
    this.sessionOpen = false;
    return this.log.append({
      type: "session_end",
      id: newEventId(),
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent: this.agent,
    });
  }

  captureGit(): GitSnapshotEvent {
    const snapshot = collectGitSnapshot(this.projectRoot);
    return this.log.append({
      type: "git_snapshot",
      id: newEventId(),
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent: this.agent,
      ...snapshot,
    });
  }

  recordFileTouch(path: string, action: FileTouchAction): FileTouchEvent {
    return this.log.append({
      type: "file_touch",
      id: newEventId(),
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent: this.agent,
      path,
      action,
    });
  }

  /**
   * Records a file_touch event for each working-tree change from `git status`.
   */
  recordWorkingTreeTouches(): FileTouchEvent[] {
    const snapshot = collectGitSnapshot(this.projectRoot);
    return snapshot.status.map((entry) =>
      this.recordFileTouch(entry.path, entry.action),
    );
  }

  recordToolCall(input: ToolCallInput): ToolCallEvent {
    const event: ToolCallEvent = {
      type: "tool_call",
      id: newEventId(),
      timestamp: nowIso(),
      session_id: this.sessionId,
      agent: this.agent,
      command: input.command,
      args: input.args ?? [],
      exit_code: input.exit_code,
    };
    if (input.stdout !== undefined) {
      event.stdout = input.stdout;
    }
    if (input.stderr !== undefined) {
      event.stderr = input.stderr;
    }
    if (input.test_pass !== undefined) {
      event.test_pass = input.test_pass;
    }
    return this.log.append(event);
  }

  getEvents(): CaptureEvent[] {
    return this.log.getEvents();
  }

  isSessionOpen(): boolean {
    return this.sessionOpen;
  }
}

export { collectGitSnapshot, parsePorcelain } from "./git.js";
export { EventLog } from "./log.js";
export type {
  CaptureEvent,
  FileTouchAction,
  FileTouchEvent,
  GitSnapshotEvent,
  ToolCallEvent,
} from "./events.js";
