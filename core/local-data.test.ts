import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicCapture } from "./capture/index.js";
import { GraphStore } from "./graph/index.js";
import * as localData from "./local-data.js";

function initRepoWithWorktree(): { base: string; mainDir: string; wtDir: string } {
  const base = mkdtempSync(join(tmpdir(), "dm-wt-"));
  const mainDir = join(base, "main");
  const wtDir = join(base, "wt-feat");
  execFileSync("git", ["init", "-b", "main", mainDir], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@dev-mem.test"], { cwd: mainDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: mainDir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: mainDir, stdio: "ignore" });
  writeFileSync(join(mainDir, "README.md"), "# Main\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: mainDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: mainDir, stdio: "ignore" });
  execFileSync("git", ["worktree", "add", wtDir, "-b", "feat/parallel"], {
    cwd: mainDir,
    stdio: "ignore",
  });
  return { base, mainDir, wtDir };
}

describe("Worktree-shared storage resolution (v0.9)", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    delete process.env.DEV_MEM_ISOLATE_WORKTREE;
    for (const d of cleanupDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // ignore transient Windows locks
      }
    }
  });

  it("resolves linked git worktrees to the shared main repo .dev-mem SQLite DB and events.jsonl", () => {
    const { base, mainDir, wtDir } = initRepoWithWorktree();
    cleanupDirs.push(base);

    const resolveRoot = (localData as any).resolveStorageRoot as ((p: string) => string) | undefined;
    expect(typeof resolveRoot).toBe("function");
    expect(realpathSync(resolveRoot!(wtDir))).toBe(realpathSync(mainDir));

    // Write node from linked worktree
    const wtStore = new GraphStore({ projectRoot: wtDir });
    const created = wtStore.createNode({
      type: "Decision",
      title: "Shared decision from linked worktree",
      content: "Visible immediately across all parallel agent worktrees",
      lifecycle_state: "active",
      evidence: {
        commit: "1111111111111111111111111111111111111111",
        files: ["README.md"],
        session_id: "wt-session",
        agent: "claude-code",
        timestamp: new Date().toISOString(),
        confidence: 0.9,
      },
    });
    wtStore.close();

    // Main worktree reads exact same node directly from shared graph.sqlite
    expect(existsSync(join(mainDir, ".dev-mem", "graph.sqlite"))).toBe(true);
    expect(existsSync(join(wtDir, ".dev-mem", "graph.sqlite"))).toBe(false);

    const mainStore = new GraphStore({ projectRoot: mainDir });
    expect(mainStore.getNode(created.id)?.title).toBe("Shared decision from linked worktree");
    mainStore.close();

    // Capture in linked worktree also lands in shared events.jsonl
    const cap = new DeterministicCapture({ projectRoot: wtDir, agent: "codex", sessionId: "wt-s2" });
    cap.startSession();
    expect(existsSync(join(mainDir, ".dev-mem", "events.jsonl"))).toBe(true);
  });

  it("allows isolating a worktree when DEV_MEM_ISOLATE_WORKTREE=1", () => {
    const { base, wtDir } = initRepoWithWorktree();
    cleanupDirs.push(base);
    process.env.DEV_MEM_ISOLATE_WORKTREE = "1";

    const resolveRoot = (localData as any).resolveStorageRoot as (p: string) => string;
    expect(realpathSync(resolveRoot(wtDir))).toBe(realpathSync(wtDir));
  });
});
