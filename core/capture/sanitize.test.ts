import { describe, it, expect } from "vitest";
import { sanitizeText, sanitizeEvent } from "./sanitize.js";
import { EventLog } from "./log.js";
import type { ToolCallEvent, CaptureEvent } from "./events.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Secret scrubber and <private> tag redaction", () => {
  it("redacts <private>...</private> blocks across multiple lines and case insensitively", () => {
    const raw = "Normal note\n<private>\nmy secret password\n</private>\nPublic note\n<PRIVATE>UPPERCASE SECRET</PRIVATE>";
    expect(sanitizeText(raw)).toBe("Normal note\n[REDACTED_PRIVATE]\nPublic note\n[REDACTED_PRIVATE]");
  });

  it("redacts Anthropic, OpenAI, Gemini, GitHub, and Bearer tokens", () => {
    const raw = [
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890abcdef",
      "OPENAI_API_KEY=sk-proj-1234567890abcdefghijkl",
      "GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "GH_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwx",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret",
    ].join("\n");

    const cleaned = sanitizeText(raw);
    expect(cleaned).not.toContain("sk-ant-");
    expect(cleaned).not.toContain("sk-proj-");
    expect(cleaned).not.toContain("AIzaSy");
    expect(cleaned).not.toContain("ghp_");
    expect(cleaned).not.toContain("eyJhbGci");
    expect(cleaned).toContain("[REDACTED_SECRET]");
  });

  it("redacts AWS access keys, Slack tokens, and .env secret assignments", () => {
    const raw = [
      "AWS_KEY=AKIAIOSFODNN7EXAMPLE",
      "SLACK_BOT=xoxb-1234567890-abcdefghij",
      "DATABASE_PASSWORD='super_secret_value_123'",
      "AUTH_TOKEN=\"another_super_secret_456\"",
    ].join("\n");

    const cleaned = sanitizeText(raw);
    expect(cleaned).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(cleaned).not.toContain("xoxb-1234567890-abcdefghij");
    expect(cleaned).not.toContain("super_secret_value_123");
    expect(cleaned).not.toContain("another_super_secret_456");
    expect(cleaned).toContain("[REDACTED_SECRET]");
  });

  it("sanitizes event fields without mutating original event object", () => {
    const original: ToolCallEvent & {
      output_summary?: string;
      error_message?: string;
      prompt?: string;
    } = {
      type: "tool_call",
      id: "evt-1",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      agent: "claude-code",
      command: "curl -H 'Authorization: Bearer secret.jwt.token' https://api.example.com",
      args: ["--token", "ghp_1234567890abcdefghijklmnopqrstuvwx"],
      exit_code: 1,
      stdout: "user: <private>secret-output</private>",
      stderr: "failed with OPENAI_API_KEY=sk-proj-1234567890abcdefghijkl",
      output_summary: "AKIAIOSFODNN7EXAMPLE was leaked",
      error_message: "Error: xoxp-1234567890-abcdefghij invalid",
      prompt: "Fix my issue with <private>my-token</private>",
    };

    const sanitized = sanitizeEvent(original);

    // Deep copy verification
    expect(sanitized).not.toBe(original);
    expect(sanitized.args).not.toBe(original.args);

    // Original remains unmutated
    expect(original.command).toContain("secret.jwt.token");
    expect(original.args[1]).toContain("ghp_");
    expect(original.stdout).toContain("secret-output");
    expect(original.stderr).toContain("sk-proj-");
    expect(original.output_summary).toContain("AKIAIOSFODNN7EXAMPLE");
    expect(original.error_message).toContain("xoxp-");
    expect(original.prompt).toContain("my-token");

    // Sanitized version has redactions
    expect(sanitized.command).not.toContain("secret.jwt.token");
    expect(sanitized.args[1]).not.toContain("ghp_");
    expect(sanitized.stdout).not.toContain("secret-output");
    expect(sanitized.stderr).not.toContain("sk-proj-");
    expect(sanitized.output_summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sanitized.error_message).not.toContain("xoxp-");
    expect(sanitized.prompt).not.toContain("my-token");

    expect(sanitized.stdout).toContain("[REDACTED_PRIVATE]");
    expect(sanitized.prompt).toContain("[REDACTED_PRIVATE]");
    expect(sanitized.stderr).toContain("[REDACTED_SECRET]");
  });

  it("automatically scrubs secrets when EventLog appends to disk and in memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-san-"));
    try {
      const logPath = join(dir, "events.jsonl");
      const log = new EventLog({ persistPath: logPath });
      const appended = log.append({
        type: "tool_call",
        id: "1",
        timestamp: new Date().toISOString(),
        session_id: "s1",
        agent: "claude-code",
        command: "cat .env",
        args: [],
        exit_code: 0,
        stdout: "OPENAI_API_KEY=sk-proj-999999999999999999999999\n<private>hidden</private>",
      });

      // Returned event is sanitized
      expect(appended.stdout).not.toContain("sk-proj-999999999999999999999999");
      expect(appended.stdout).not.toContain("hidden");

      // In-memory events are sanitized
      const inMemory = log.getEvents()[0] as ToolCallEvent;
      expect(inMemory.stdout).not.toContain("sk-proj-999999999999999999999999");
      expect(inMemory.stdout).toContain("[REDACTED_SECRET]");
      expect(inMemory.stdout).toContain("[REDACTED_PRIVATE]");

      // On-disk events are sanitized
      const onDisk = readFileSync(logPath, "utf8");
      expect(onDisk).not.toContain("sk-proj-999999999999999999999999");
      expect(onDisk).not.toContain("hidden");
      expect(onDisk).toContain("[REDACTED_SECRET]");
      expect(onDisk).toContain("[REDACTED_PRIVATE]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles falsy and non-string inputs safely", () => {
    expect(sanitizeText("")).toBe("");
    expect(sanitizeText(undefined as any)).toBe(undefined);
    expect(sanitizeText(null as any)).toBe(null);
    expect(sanitizeEvent(null as any)).toBe(null);
    expect(sanitizeEvent(undefined as any)).toBe(undefined);
  });

  it("sanitizes git snapshot diffs and commit messages", () => {
    const gitEvt: CaptureEvent = {
      type: "git_snapshot",
      id: "g1",
      timestamp: new Date().toISOString(),
      session_id: "s1",
      agent: "claude-code",
      branch: "main",
      head_commit: "abcd",
      worktree: "/app",
      worktrees: [],
      status: [],
      diff: "diff --git a/.env\n+OPENAI_API_KEY=sk-proj-1234567890abcdefghijkl",
      staged_diff: "diff --git a/token\n+<private>supersecret</private>",
      recent_commits: [
        {
          sha: "1111",
          subject: "fix: update token ghp_1234567890abcdefghijklmnopqrstuvwx",
          author_name: "Dev",
          author_email: "dev@example.com",
          committed_at: new Date().toISOString(),
        },
      ],
    };

    const sanitized = sanitizeEvent(gitEvt);
    expect(sanitized.diff).toContain("[REDACTED_SECRET]");
    expect(sanitized.diff).not.toContain("sk-proj-");
    expect(sanitized.staged_diff).toContain("[REDACTED_PRIVATE]");
    expect(sanitized.staged_diff).not.toContain("supersecret");
    expect((sanitized as any).recent_commits[0].subject).toContain("[REDACTED_SECRET]");
    expect((sanitized as any).recent_commits[0].subject).not.toContain("ghp_");
  });
});
