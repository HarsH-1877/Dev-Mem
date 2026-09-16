export type CaptureAgent = "claude-code" | "codex" | "cursor" | (string & {});

export type FileTouchAction = "created" | "modified" | "deleted" | "touched";

export interface CaptureEventBase {
  id: string;
  timestamp: string;
  session_id: string;
  agent: string;
}

export interface SessionStartEvent extends CaptureEventBase {
  type: "session_start";
  project_root: string;
}

export interface SessionEndEvent extends CaptureEventBase {
  type: "session_end";
}

export interface GitCommitInfo {
  sha: string;
  subject: string;
  author_name: string;
  author_email: string;
  committed_at: string;
}

export interface GitWorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
}

export interface GitStatusEntry {
  path: string;
  index_status: string;
  worktree_status: string;
  action: FileTouchAction;
}

export interface GitSnapshotEvent extends CaptureEventBase {
  type: "git_snapshot";
  branch: string | null;
  head_commit: string | null;
  worktree: string;
  worktrees: GitWorktreeInfo[];
  status: GitStatusEntry[];
  diff: string;
  staged_diff: string;
  recent_commits: GitCommitInfo[];
}

export interface FileTouchEvent extends CaptureEventBase {
  type: "file_touch";
  path: string;
  action: FileTouchAction;
}

export interface ToolCallEvent extends CaptureEventBase {
  type: "tool_call";
  command: string;
  args: string[];
  exit_code: number;
  stdout?: string;
  stderr?: string;
  /** Present when the command is known to be a test run. */
  test_pass?: boolean;
}

export type CaptureEvent =
  | SessionStartEvent
  | SessionEndEvent
  | GitSnapshotEvent
  | FileTouchEvent
  | ToolCallEvent;
