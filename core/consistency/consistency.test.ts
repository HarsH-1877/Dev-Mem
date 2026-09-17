import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../../core/graph/index.js";
import { checkContradictions, checkStaleness } from "../../core/consistency/index.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "dev-mem-consistency-test-"));
  dbPath = join(tmpDir, "graph.sqlite");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(store: GraphStore, overrides: {
  type?: string;
  title?: string;
  files?: string[];
  state?: string;
}) {
  return store.createNode({
    type: (overrides.type ?? "Decision") as any,
    title: overrides.title ?? "Use Firebase Auth",
    content: "",
    lifecycle_state: (overrides.state ?? "observed") as any,
    evidence: {
      commit: "abc1234",
      files: overrides.files ?? ["src/auth.ts"],
      confidence: 0.9,
      session_id: "sess_x",
      agent: "claude-code",
      timestamp: new Date().toISOString(),
    },
  });
}

// ─── Staleness tests ──────────────────────────────────────────────────────

describe("checkStaleness", () => {
  it("marks a node stale when all its cited files are missing from disk", () => {
    const store = new GraphStore({ dbPath, ephemeral: true });
    const n = makeNode(store, { files: ["ghost-file-that-does-not-exist.ts"] });
    expect(n.lifecycle_state).toBe("observed");
    store.close();

    const result = checkStaleness(tmpDir, dbPath);

    expect(result.markedStale).toContain(n.id);
    expect(result.details[0]).toContain("ghost-file");

    // Verify persisted state
    const store2 = new GraphStore({ dbPath, ephemeral: true });
    const updated = store2.getNode(n.id);
    store2.close();
    expect(updated?.lifecycle_state).toBe("stale");
  });

  it("does NOT mark a node stale when at least one cited file exists", () => {
    // Write a real file in tmpDir
    writeFileSync(join(tmpDir, "real-file.ts"), "// real");

    const store = new GraphStore({ dbPath, ephemeral: true });
    const n = makeNode(store, { files: ["real-file.ts", "missing-file.ts"] });
    store.close();

    const result = checkStaleness(tmpDir, dbPath);

    // Should NOT be stale because real-file.ts exists
    expect(result.markedStale).not.toContain(n.id);
  });

  it("skips already-stale and superseded nodes", () => {
    const store = new GraphStore({ dbPath, ephemeral: true });
    const n1 = makeNode(store, { files: ["no-file.ts"], state: "stale" });
    const n2 = makeNode(store, { files: ["no-file.ts"], state: "superseded" });
    store.close();

    const result = checkStaleness(tmpDir, dbPath);

    expect(result.markedStale).not.toContain(n1.id);
    expect(result.markedStale).not.toContain(n2.id);
  });

  it("handles multiple nodes — only stales those missing all files", () => {
    writeFileSync(join(tmpDir, "exists.ts"), "// ok");

    const store = new GraphStore({ dbPath, ephemeral: true });
    const ok = makeNode(store, { files: ["exists.ts"] });
    const stale = makeNode(store, { files: ["does-not-exist.ts"] });
    store.close();

    const result = checkStaleness(tmpDir, dbPath);

    expect(result.markedStale).toContain(stale.id);
    expect(result.markedStale).not.toContain(ok.id);
    expect(result.markedStale).toHaveLength(1);
  });
});

// ─── Contradiction tests ──────────────────────────────────────────────────

describe("checkContradictions (heuristic, no API key)", () => {
  it("creates a contradicts edge between an affirmative and a negating node", async () => {
    const store = new GraphStore({ dbPath, ephemeral: true });
    const existing = makeNode(store, {
      title: "Use Firebase Auth for server-side authentication",
      files: ["src/auth.ts"],
    });
    store.close();

    // New node inserted separately; then contradiction check runs
    const store2 = new GraphStore({ dbPath, ephemeral: true });
    const newNode = makeNode(store2, {
      title: "Avoid Firebase Auth — causes vendor lock-in",
      files: ["src/auth.ts"],
    });
    store2.close();

    // No API key → heuristic path
    const result = await checkContradictions(newNode, tmpDir, dbPath);

    expect(result.edgesCreated.length).toBeGreaterThan(0);
    expect(result.conflicts[0]).toContain("contradicts");

    // Verify edge is stored
    const store3 = new GraphStore({ dbPath, ephemeral: true });
    const edges = store3.listEdges();
    store3.close();
    const contradictEdge = edges.find((e) => e.type === "contradicts");
    expect(contradictEdge).toBeDefined();
    expect(contradictEdge?.from_id).toBe(newNode.id);
    expect(contradictEdge?.to_id).toBe(existing.id);
  });

  it("does NOT flag two compatible nodes as contradicting", async () => {
    const store = new GraphStore({ dbPath, ephemeral: true });
    const existing = makeNode(store, {
      title: "Use Firebase Auth for server-side authentication",
      files: ["src/auth.ts"],
    });
    store.close();

    const store2 = new GraphStore({ dbPath, ephemeral: true });
    const newNode = makeNode(store2, {
      title: "Use JWT tokens for API authorization",
      files: ["src/auth.ts"],
    });
    store2.close();

    const result = await checkContradictions(newNode, tmpDir, undefined, dbPath);

    // These don't structurally contradict (both affirming different things)
    expect(result.edgesCreated).toHaveLength(0);
  });

  it("skips FailedApproach nodes — only contradiction-eligible types checked", async () => {
    const store = new GraphStore({ dbPath, ephemeral: true });
    store.createNode({
      type: "FailedApproach",
      title: "Avoid using JWTs — they were too complex",
      evidence: {
        commit: "abc",
        files: ["src/auth.ts"],
        confidence: 0.9,
        session_id: "s1",
        agent: "claude-code",
        timestamp: new Date().toISOString(),
      },
    });
    store.close();

    const store2 = new GraphStore({ dbPath, ephemeral: true });
    const newNode = makeNode(store2, {
      type: "Decision",
      title: "Use JWTs for stateless auth",
      files: ["src/auth.ts"],
    });
    store2.close();

    const result = await checkContradictions(newNode, tmpDir, undefined, dbPath);

    // FailedApproach is not in CONTRADICTION_TYPES, should not be flagged
    expect(result.edgesCreated).toHaveLength(0);
  });
});
