import { execFileSync } from "node:child_process";
import type {
  FileTouchAction,
  GitCommitInfo,
  GitStatusEntry,
  GitWorktreeInfo,
} from "./events.js";

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    throw new Error(
      `git ${args.join(" ")} failed (exit ${err.status ?? "?"}): ${err.stderr ?? ""}`,
    );
  }
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

export interface GitSnapshot {
  branch: string | null;
  head_commit: string | null;
  worktree: string;
  worktrees: GitWorktreeInfo[];
  status: GitStatusEntry[];
  diff: string;
  staged_diff: string;
  recent_commits: GitCommitInfo[];
}

export function collectGitSnapshot(
  repoPath: string,
  recentCommitLimit = 20,
): GitSnapshot {
  const worktree = runGit(repoPath, ["rev-parse", "--show-toplevel"]);
  const branch = tryGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head_commit = tryGit(repoPath, ["rev-parse", "HEAD"]);
  const statusRaw = tryGit(repoPath, ["status", "--porcelain", "-u"]) ?? "";
  const diff = tryGit(repoPath, ["diff"]) ?? "";
  const staged_diff = tryGit(repoPath, ["diff", "--cached"]) ?? "";
  const worktrees = parseWorktrees(
    tryGit(repoPath, ["worktree", "list", "--porcelain"]) ?? "",
  );
  const log = tryGit(repoPath, [
    "log",
    `-n${recentCommitLimit}`,
    "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%aI",
  ]);

  return {
    branch: branch === "HEAD" ? null : branch,
    head_commit,
    worktree,
    worktrees,
    status: parsePorcelain(statusRaw),
    diff,
    staged_diff,
    recent_commits: parseLog(log),
  };
}

export function parsePorcelain(raw: string): GitStatusEntry[] {
  if (raw.trim() === "") {
    return [];
  }

  const entries: GitStatusEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length < 3) {
      continue;
    }
    const index_status = line[0] ?? " ";
    const worktree_status = line[1] ?? " ";
    let path = line.slice(3);
    if (path.includes(" -> ")) {
      path = path.split(" -> ").at(-1) ?? path;
    }
    entries.push({
      path,
      index_status,
      worktree_status,
      action: inferAction(index_status, worktree_status),
    });
  }
  return entries;
}

function inferAction(index: string, worktree: string): FileTouchAction {
  if (index === "D" || worktree === "D") {
    return "deleted";
  }
  if (index === "?" || index === "A" || worktree === "?") {
    return "created";
  }
  if (index === "M" || worktree === "M") {
    return "modified";
  }
  return "touched";
}

function parseWorktrees(raw: string): GitWorktreeInfo[] {
  if (raw.trim() === "") {
    return [];
  }
  const trees: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> = {};
  for (const line of raw.split("\n")) {
    if (line === "") {
      if (current.path) {
        trees.push({
          path: current.path,
          head: current.head ?? "",
          branch: current.branch ?? null,
        });
      }
      current = {};
      continue;
    }
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.branch = null;
    }
  }
  if (current.path) {
    trees.push({
      path: current.path,
      head: current.head ?? "",
      branch: current.branch ?? null,
    });
  }
  return trees;
}

function parseLog(raw: string | null): GitCommitInfo[] {
  if (!raw || raw.trim() === "") {
    return [];
  }
  return raw.split("\n").flatMap((line) => {
    const [sha, subject, author_name, author_email, committed_at] =
      line.split("\x1f");
    if (!sha || !subject || !author_name || !author_email || !committed_at) {
      return [];
    }
    return [{ sha, subject, author_name, author_email, committed_at }];
  });
}
