import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraphStore } from "./index.js";
import type { Evidence } from "./types.js";

function sampleEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    files: ["src/auth.ts"],
    diff_ref: "bbbbbbb..aaaaaaa",
    session_id: "sess_1",
    agent: "claude-code",
    timestamp: "2026-09-16T12:00:00.000Z",
    confidence: 0.9,
    ...overrides,
  };
}

describe("GraphStore", () => {
  const stores: GraphStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) {
      store.close();
    }
  });

  function openMemory(): GraphStore {
    const store = new GraphStore({ dbPath: ":memory:", ephemeral: true });
    stores.push(store);
    return store;
  }

  it("creates nodes with §5.4 evidence and defaults to observed", () => {
    const store = openMemory();
    const node = store.createNode({
      type: "Decision",
      title: "Use SQLite for the graph store",
      content: "Local-first, no server.",
      evidence: sampleEvidence(),
    });

    expect(node.lifecycle_state).toBe("observed");
    expect(node.evidence.commit).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(node.evidence.files).toEqual(["src/auth.ts"]);
    expect(node.evidence.diff_ref).toBe("bbbbbbb..aaaaaaa");
    expect(node.evidence.session_id).toBe("sess_1");
    expect(node.evidence.agent).toBe("claude-code");
    expect(node.evidence.timestamp).toBe("2026-09-16T12:00:00.000Z");
    expect(node.evidence.confidence).toBe(0.9);
    expect(store.getNode(node.id)?.title).toBe(
      "Use SQLite for the graph store",
    );
  });

  it("rejects evidence missing required fields", () => {
    const store = openMemory();
    expect(() =>
      store.createNode({
        type: "Discovery",
        title: "Broken evidence",
        evidence: sampleEvidence({ files: [] }),
      }),
    ).toThrow(/files/);
    expect(() =>
      store.createNode({
        type: "Discovery",
        title: "Bad confidence",
        evidence: sampleEvidence({ confidence: 1.2 }),
      }),
    ).toThrow(/confidence/);
  });

  it("queries nodes by type", () => {
    const store = openMemory();
    store.createNode({
      type: "Decision",
      title: "A",
      evidence: sampleEvidence({ files: ["a.ts"] }),
    });
    store.createNode({
      type: "FailedApproach",
      title: "B",
      evidence: sampleEvidence({ files: ["b.ts"] }),
    });
    store.createNode({
      type: "Decision",
      title: "C",
      evidence: sampleEvidence({ files: ["c.ts"] }),
    });

    const decisions = store.queryByType("Decision");
    expect(decisions.map((n) => n.title)).toEqual(["A", "C"]);
    expect(store.queryByType("OpenIssue")).toEqual([]);
  });

  it("transitions lifecycle states along the allowed graph", () => {
    const store = openMemory();
    const node = store.createNode({
      type: "Constraint",
      title: "Keep auth behind AuthProvider",
      evidence: sampleEvidence(),
    });

    expect(store.transitionLifecycleState(node.id, "verified").lifecycle_state).toBe(
      "verified",
    );
    expect(store.transitionLifecycleState(node.id, "active").lifecycle_state).toBe(
      "active",
    );
    expect(store.transitionLifecycleState(node.id, "stale").lifecycle_state).toBe(
      "stale",
    );
    expect(() => store.transitionLifecycleState(node.id, "observed")).toThrow(
      /Invalid lifecycle transition/,
    );

    const history = store.listLifecycleHistory(node.id);
    expect(history.map((h) => h.to_state)).toEqual([
      "observed",
      "verified",
      "active",
      "stale",
    ]);
  });

  it("allows V1 shortcut observed → active", () => {
    const store = openMemory();
    const node = store.createNode({
      type: "Convention",
      title: "Zod on all API routes",
      evidence: sampleEvidence(),
    });
    expect(
      store.transitionLifecycleState(node.id, "active").lifecycle_state,
    ).toBe("active");
  });

  it("creates edges and marks superseded targets", () => {
    const store = openMemory();
    const oldNode = store.createNode({
      type: "Decision",
      title: "Use in-memory map",
      evidence: sampleEvidence({ files: ["old.ts"] }),
    });
    store.transitionLifecycleState(oldNode.id, "active");
    const newNode = store.createNode({
      type: "Decision",
      title: "Use SQLite",
      evidence: sampleEvidence({ files: ["new.ts"] }),
    });

    const edge = store.createEdge({
      from_id: newNode.id,
      to_id: oldNode.id,
      type: "supersedes",
    });

    expect(edge.type).toBe("supersedes");
    expect(store.getNode(oldNode.id)?.lifecycle_state).toBe("superseded");
    expect(() => store.transitionLifecycleState(oldNode.id, "active")).toThrow(
      /Invalid lifecycle transition/,
    );
  });

  it("walks supersedes chains with a recursive CTE", () => {
    const store = openMemory();
    const a = store.createNode({
      type: "Decision",
      title: "A",
      evidence: sampleEvidence({ files: ["a.ts"] }),
    });
    const b = store.createNode({
      type: "Decision",
      title: "B",
      evidence: sampleEvidence({ files: ["b.ts"] }),
    });
    const c = store.createNode({
      type: "Decision",
      title: "C",
      evidence: sampleEvidence({ files: ["c.ts"] }),
    });
    store.createEdge({ from_id: a.id, to_id: b.id, type: "supersedes" });
    store.createEdge({ from_id: b.id, to_id: c.id, type: "supersedes" });

    const hops = store.walk(a.id, "supersedes", "outgoing");
    expect(hops.map((h) => h.id)).toEqual([b.id, c.id]);
    expect(hops.map((h) => h.depth)).toEqual([1, 2]);
  });

  it("writes graph.sqlite under .dev-mem and gitignores it", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-mem-graph-"));
    const store = new GraphStore({ projectRoot: root });
    stores.push(store);
    store.createNode({
      type: "Discovery",
      title: "On disk",
      evidence: sampleEvidence(),
    });

    expect(existsSync(join(root, ".dev-mem", "graph.sqlite"))).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".dev-mem/");
  });
});
