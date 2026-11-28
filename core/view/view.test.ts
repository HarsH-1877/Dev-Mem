import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../graph/index.js";
import { generateStaticReport } from "./index.js";

const EV = {
  commit: "1111111111111111111111111111111111111111",
  files: ["src/auth.ts"],
  symbols: ["verifyJwt"],
  session_id: "s-view",
  agent: "claude-code",
  timestamp: "2026-10-16T00:00:00.000Z",
  confidence: 0.92,
};

describe("Static HTML Graph Explorer (core/view/index.ts)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dm-view-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // ignore transient Windows locks
    }
  });

  it("generates a self-contained zero-CDN static HTML explorer with safely escaped graph JSON", () => {
    const store = new GraphStore({ projectRoot: dir });
    const n1 = store.createNode({
      type: "Decision",
      title: "Use PostgreSQL <script>alert(1)</script>",
      content: "Store structured </script> ledger records safely",
      lifecycle_state: "verified",
      evidence: EV,
    });
    const n2 = store.createNode({
      type: "FailedApproach",
      title: "In-memory map lost sessions",
      content: "Process restarts wiped active map",
      lifecycle_state: "active",
      evidence: EV,
    });
    store.createEdge({ from_id: n1.id, to_id: n2.id, type: "supersedes" });
    store.close();

    const res = generateStaticReport(dir);
    expect(res.nodeCount).toBe(2);
    expect(res.edgeCount).toBe(1);
    expect(existsSync(res.path)).toBe(true);

    const html = readFileSync(res.path, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Dev-Mem Explorer");
    expect(html).toContain("In-memory map lost sessions");
    expect(html).toContain("verifyJwt");
    // Escaped script tag prevents breaking out of inline JSON payload
    expect(html).not.toContain("<script>alert(1)</script>");
    // Zero external CDNs
    expect(html).not.toMatch(/https?:\/\/cdn/i);
  });
});
