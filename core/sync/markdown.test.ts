import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../graph/index.js";
import { exportMemoryMarkdown } from "./markdown.js";

const BASE_EVIDENCE = {
  commit: "1111111111111111111111111111111111111111",
  files: ["src/app.ts"],
  session_id: "s-md",
  agent: "claude-code",
  timestamp: "2026-10-16T00:00:00.000Z",
  confidence: 0.9,
};

describe("Markdown Memory Projection (core/sync/markdown.ts)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-md-export-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // ignore transient Windows handle locks
    }
  });

  it("exports curated verified/active nodes into deterministic grouped MEMORY.md and excludes observed/superseded", () => {
    const store = new GraphStore({ projectRoot: dir });
    try {
      store.createNode({
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        type: "Decision",
        title: "Use PostgreSQL 16",
        content: "Chosen for JSONB indexing and advisory locks.",
        lifecycle_state: "verified",
        evidence: { ...BASE_EVIDENCE, files: ["src/db.ts"] },
      });
      store.createNode({
        id: "bbbbbbbb-0000-4000-8000-000000000002",
        type: "Constraint",
        title: "Zero runtime deps beyond better-sqlite3",
        content: "Keep core lightweight and installable offline.",
        lifecycle_state: "active",
        evidence: { ...BASE_EVIDENCE, files: ["package.json"] },
      });
      store.createNode({
        id: "cccccccc-0000-4000-8000-000000000003",
        type: "Discovery",
        title: "Unreviewed scratch discovery",
        content: "Should not appear in curated export.",
        lifecycle_state: "observed",
        evidence: BASE_EVIDENCE,
      });
      store.createNode({
        id: "dddddddd-0000-4000-8000-000000000004",
        type: "FailedApproach",
        title: "Superseded failed idea",
        content: "Should be excluded too.",
        lifecycle_state: "superseded",
        evidence: BASE_EVIDENCE,
      });
    } finally {
      store.close();
    }

    const res = exportMemoryMarkdown(dir);
    expect(res.exportedNodes).toBe(2);
    expect(existsSync(res.path)).toBe(true);

    const md = readFileSync(res.path, "utf8");
    expect(md).toContain("## Constraints");
    expect(md).toContain("## Decisions");
    expect(md).toContain("[bbbbbbbb]");
    expect(md).toContain("Zero runtime deps beyond better-sqlite3");
    expect(md).toContain("[aaaaaaaa]");
    expect(md).toContain("Use PostgreSQL 16");
    expect(md).not.toContain("Unreviewed scratch discovery");
    expect(md).not.toContain("Superseded failed idea");
  });

  it("enforces maxLines budget and writes bounded AGENTS.md block without clobbering user text", () => {
    const store = new GraphStore({ projectRoot: dir });
    try {
      for (let i = 0; i < 20; i++) {
        store.createNode({
          type: i % 2 === 0 ? "Constraint" : "Decision",
          title: `Rule number ${i + 1}`,
          content: `Detailed rationale for rule number ${i + 1}`,
          lifecycle_state: "verified",
          evidence: BASE_EVIDENCE,
        });
      }
    } finally {
      store.close();
    }

    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Team Agents Guide\n\nAlways run tests before merging.\n",
      "utf8",
    );

    const res = exportMemoryMarkdown(dir, { agentsMd: true, maxLines: 18 });
    const mdLines = readFileSync(res.path, "utf8").trimEnd().split("\n");
    expect(mdLines.length).toBeLessThanOrEqual(18);
    expect(readFileSync(res.path, "utf8")).toContain("Showing");

    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("Always run tests before merging.");
    expect(agents).toContain("<!-- dev-mem:start -->");
    expect(agents).toContain("<!-- dev-mem:end -->");
    expect(agents).toContain(".dev-mem/MEMORY.md");

    // Re-running updates idempotently without duplicating markers
    exportMemoryMarkdown(dir, { agentsMd: true, maxLines: 18 });
    const agentsSecond = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agentsSecond.match(/<!-- dev-mem:start -->/g)?.length).toBe(1);
    expect(agentsSecond.match(/<!-- dev-mem:end -->/g)?.length).toBe(1);
  });
});
