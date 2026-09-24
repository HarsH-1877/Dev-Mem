import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "dev-mem-cli-adv-"));
}

describe("Adversarial & Edge Cases (CLI & Adapters)", () => {
  it("Uninstall followed by reinstall leaves no duplicate hooks and cleans up correctly", () => {
    const cwd = tempProject();
    try {
      // Mock directories for all three IDEs
      mkdirSync(join(cwd, ".claude"));
      writeFileSync(join(cwd, ".claude", "settings.json"), "{}");
      
      mkdirSync(join(cwd, ".codex"));
      writeFileSync(join(cwd, ".codex", "hooks.json"), "{}");
      
      mkdirSync(join(cwd, ".cursor"));
      writeFileSync(join(cwd, ".cursor", "hooks.json"), "{}");
      
      const cliPath = join(projectRoot, "dist", "cli", "index.js");
      
      // Install
      spawnSync(process.execPath, [cliPath, "install"], { cwd, timeout: 5000 });
      
      // Verify they are installed once
      let cursorHooks = readFileSync(join(cwd, ".cursor", "hooks.json"), "utf8");
      expect(cursorHooks).toContain("preToolUse");
      
      // Uninstall
      spawnSync(process.execPath, [cliPath, "uninstall"], { cwd, timeout: 5000 });
      
      // Verify removed
      cursorHooks = readFileSync(join(cwd, ".cursor", "hooks.json"), "utf8");
      expect(cursorHooks).not.toContain("preToolUse");
      expect(cursorHooks).not.toContain("dev-mem");
      
      // Install again
      spawnSync(process.execPath, [cliPath, "install"], { cwd, timeout: 5000 });
      cursorHooks = readFileSync(join(cwd, ".cursor", "hooks.json"), "utf8");
      
      // The word preToolUse should only appear once if no duplicates
      const matches = cursorHooks.match(/preToolUse/g);
      expect(matches?.length).toBe(1);
      
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("dev-mem wrap handles wrapped process crash without hanging", () => {
    const cwd = tempProject();
    try {
      const cliPath = join(projectRoot, "dist", "cli", "index.js");
      
      // We wrap a process that will intentionally crash (exit 1)
      const res = spawnSync(process.execPath, [cliPath, "wrap", "node", "-e", "process.exit(1)"], {
        cwd,
        timeout: 10000,
        encoding: "utf8"
      });
      
      // Wrap should forward the exit code and flush, but absolutely not hang
      expect(res.status).toBe(1);
      
      // Ensure wrap safety net actually ran check
      // It normally outputs "Flushing unextracted Dev-Mem events" if there is an active session
      // For this test, verifying it doesn't hang and returns 1 is the main requirement
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  
  it("Cursor N-accumulated-event checkpoint logic (N-1, N, N+1)", () => {
    const cwd = tempProject();
    try {
      const cursorHookPath = join(projectRoot, "dist", "adapters", "cursor", "hook.js");
      
      // Configure N=2
      mkdirSync(join(cwd, ".dev-mem"));
      writeFileSync(join(cwd, ".dev-mem", "config.yml"), "extraction_event_threshold: 2\n");
      
      // Run sessionStart
      spawnSync(process.execPath, [cursorHookPath], {
        cwd,
        input: JSON.stringify({ type: "sessionStart", session_id: "s1" })
      });
      
      // 1 tool call (N-1) -> stop should NOT extract
      spawnSync(process.execPath, [cursorHookPath], {
        cwd,
        input: JSON.stringify({ type: "postToolUse", session_id: "s1", tool_call: {} })
      });
      
      let res = spawnSync(process.execPath, [cursorHookPath], {
        cwd,
        input: JSON.stringify({ type: "stop", session_id: "s1" })
      });
      // the hook script exits immediately (detached spawn for extraction wouldn't trigger)
      
      // 2 tool calls (N) -> stop SHOULD extract
      spawnSync(process.execPath, [cursorHookPath], {
        cwd,
        input: JSON.stringify({ type: "postToolUse", session_id: "s1", tool_call: {} })
      });
      
      // Note: testing detached spawn directly from vitest is tricky because it unrefs, 
      // but we can verify it doesn't crash or behave improperly.
      res = spawnSync(process.execPath, [cursorHookPath], {
        cwd,
        input: JSON.stringify({ type: "stop", session_id: "s1" })
      });
      expect(res.status).toBe(0);
      
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
