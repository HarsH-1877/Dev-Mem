import { describe, it, expect } from "vitest";
import { exportSharedGraph, importSharedGraph, syncSharedGraph, getSharedGraphPath, SHARED_GRAPH_FILENAME } from "./index.js";
import { GraphStore } from "../graph/index.js";
import { ensureDevMemGitignore } from "../local-data.js";
import { mkdtempSync, copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function safeRm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows file locking transient fallback
  }
}


describe("Git-friendly Team Memory Sync (.dev-mem/shared.jsonl)", () => {
  it("exports active/verified nodes deterministically and imports them into a teammate's empty SQLite store", () => {
    const devA = mkdtempSync(join(tmpdir(), "dm-sync-a-"));
    const devB = mkdtempSync(join(tmpdir(), "dm-sync-b-"));
    try {
      const storeA = new GraphStore({ projectRoot: devA });
      const activeNode = storeA.createNode({
        type: "Decision",
        title: "Use Zod for request validation",
        content: "All API routes validate body with Zod schemas",
        lifecycle_state: "active",
        evidence: {
          commit: "1111111111111111111111111111111111111111",
          files: ["src/api.ts"],
          session_id: "s1",
          agent: "claude-code",
          timestamp: "2026-10-16T00:00:00.000Z",
          confidence: 0.92,
        },
      });
      const verifiedNode = storeA.createNode({
        type: "Convention",
        title: "All route handlers must be pure functions",
        content: "Pure handlers simplify unit tests",
        lifecycle_state: "verified",
        evidence: {
          commit: "1111111111111111111111111111111111111111",
          files: ["src/api.ts"],
          session_id: "s1",
          agent: "claude-code",
          timestamp: "2026-10-16T00:00:00.000Z",
          confidence: 0.95,
        },
      });
      // Edge between the two exported nodes
      storeA.createEdge({
        from_id: activeNode.id,
        to_id: verifiedNode.id,
        type: "depends-on",
      });

      // Unverified 'observed' node should NOT be exported to shared team memory
      const observedNode = storeA.createNode({
        type: "Discovery",
        title: "Unverified local scratch observation",
        content: "Temp",
        lifecycle_state: "observed",
        evidence: {
          commit: "1111111111111111111111111111111111111111",
          files: ["src/api.ts"],
          session_id: "s1",
          agent: "claude-code",
          timestamp: "2026-10-16T00:00:00.000Z",
          confidence: 0.7,
        },
      });
      // Edge to observed node should NOT be exported
      storeA.createEdge({
        from_id: activeNode.id,
        to_id: observedNode.id,
        type: "depends-on",
      });

      storeA.close();

      const exp = exportSharedGraph(devA);
      expect(exp.exportedNodes).toBe(2);
      expect(exp.exportedEdges).toBe(1);
      expect(existsSync(exp.path)).toBe(true);

      const content = readFileSync(exp.path, "utf8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(3); // 2 nodes + 1 edge

      // Simulate git pull on teammate machine devB
      mkdirSync(join(devB, ".dev-mem"), { recursive: true });
      copyFileSync(join(devA, ".dev-mem", "shared.jsonl"), join(devB, ".dev-mem", "shared.jsonl"));

      const imp = importSharedGraph(devB);
      expect(imp.importedNodes).toBe(2);
      expect(imp.importedEdges).toBe(1);
      expect(imp.updatedNodes).toBe(0);

      const storeB = new GraphStore({ projectRoot: devB });
      const fetchedActive = storeB.getNode(activeNode.id);
      expect(fetchedActive?.title).toBe("Use Zod for request validation");
      expect(fetchedActive?.lifecycle_state).toBe("active");

      const fetchedVerified = storeB.getNode(verifiedNode.id);
      expect(fetchedVerified?.title).toBe("All route handlers must be pure functions");
      expect(fetchedVerified?.lifecycle_state).toBe("verified");

      const edgesB = storeB.listEdges();
      expect(edgesB.length).toBe(1);
      expect(edgesB[0].from_id).toBe(activeNode.id);
      expect(edgesB[0].to_id).toBe(verifiedNode.id);
      storeB.close();
    } finally {
      safeRm(devA);
      safeRm(devB);
    }
  });

  it("promotes local observed node to active/verified when incoming record has higher lifecycle state", () => {
    const root = mkdtempSync(join(tmpdir(), "dm-sync-promote-"));
    try {
      const store = new GraphStore({ projectRoot: root });
      const node = store.createNode({
        type: "Decision",
        title: "GraphQL for reporting",
        content: "Initial local thought",
        lifecycle_state: "observed",
        evidence: {
          commit: "1111111111111111111111111111111111111111",
          files: ["src/report.ts"],
          session_id: "s1",
          agent: "claude-code",
          timestamp: "2026-10-16T00:00:00.000Z",
          confidence: 0.6,
        },
      });
      store.close();

      const sharedPath = getSharedGraphPath(root);
      const incomingRecord = {
        record_type: "node",
        node: {
          id: node.id,
          type: "Decision",
          title: "GraphQL for reporting",
          content: "Team agreed and verified in production",
          lifecycle_state: "active",
          evidence: {
            commit: "2222222222222222222222222222222222222222",
            files: ["src/report.ts"],
            session_id: "s2",
            agent: "claude-code",
            timestamp: "2026-10-16T01:00:00.000Z",
            confidence: 0.95,
          },
        },
      };
      writeFileSync(sharedPath, JSON.stringify(incomingRecord) + "\n", "utf8");

      const imp = importSharedGraph(root);
      expect(imp.importedNodes).toBe(0);
      expect(imp.updatedNodes).toBe(1);

      const storeAfter = new GraphStore({ projectRoot: root });
      const updated = storeAfter.getNode(node.id);
      expect(updated?.lifecycle_state).toBe("active");
      storeAfter.close();
    } finally {
      safeRm(root);
    }
  });

  it("handles missing or empty shared.jsonl and ignores corrupt lines gracefully", () => {
    const root = mkdtempSync(join(tmpdir(), "dm-sync-edge-cases-"));
    try {
      // 1. Missing shared.jsonl
      const impEmpty = importSharedGraph(root);
      expect(impEmpty).toEqual({ importedNodes: 0, updatedNodes: 0, importedEdges: 0 });

      // 2. Corrupt lines mixed with valid node
      ensureDevMemGitignore(root);
      const sharedPath = getSharedGraphPath(root);
      mkdirSync(join(root, ".dev-mem"), { recursive: true });
      const validNode = {
        id: "valid-1",
        type: "Decision",
        title: "Valid Node",
        content: "Clean",
        lifecycle_state: "active",
        evidence: {
          commit: "1111111111111111111111111111111111111111",
          files: ["src/a.ts"],
          session_id: "s1",
          agent: "claude-code",
          timestamp: "2026-10-16T00:00:00.000Z",
          confidence: 0.9,
        },
      };
      const corruptContent = [
        "not-valid-json",
        JSON.stringify({ record_type: "node", node: validNode }),
        "{ incomplete json",
        JSON.stringify({ record_type: "unknown", foo: "bar" }),
      ].join("\n");
      writeFileSync(sharedPath, corruptContent + "\n", "utf8");

      const impCorrupt = importSharedGraph(root);
      expect(impCorrupt.importedNodes).toBe(1);
      expect(impCorrupt.updatedNodes).toBe(0);

      // Idempotency: re-running import does not duplicate
      const impRepeat = importSharedGraph(root);
      expect(impRepeat.importedNodes).toBe(0);
      expect(impRepeat.updatedNodes).toBe(0);
    } finally {
      safeRm(root);
    }
  });

  it("syncSharedGraph performs bidirectional import and export", () => {
    const root = mkdtempSync(join(tmpdir(), "dm-sync-bidirectional-"));
    try {
      const store = new GraphStore({ projectRoot: root });
      store.createNode({
        type: "Constraint",
        title: "Node 18+ required for runtime",
        content: "Target LTS",
        lifecycle_state: "active",
        evidence: {
          commit: "1111111111111111111111111111111111111111",
          files: ["package.json"],
          session_id: "s1",
          agent: "claude-code",
          timestamp: "2026-10-16T00:00:00.000Z",
          confidence: 0.9,
        },
      });
      store.close();

      const result = syncSharedGraph(root);
      expect(result.importedNodes).toBe(0);
      expect(result.updatedNodes).toBe(0);
      expect(result.exportedNodes).toBe(1);

      const sharedPath = getSharedGraphPath(root);
      expect(existsSync(sharedPath)).toBe(true);
      const lines = readFileSync(sharedPath, "utf8").trim().split("\n");
      expect(lines.length).toBe(1);
    } finally {
      safeRm(root);
    }
  });

  it("ensureDevMemGitignore allows shared.jsonl to be committed while ignoring other .dev-mem files", () => {
    const root = mkdtempSync(join(tmpdir(), "dm-sync-gitignore-"));
    try {
      // 1. Fresh creation
      ensureDevMemGitignore(root);
      const gitignore1 = readFileSync(join(root, ".gitignore"), "utf8");
      expect(gitignore1).toContain(".dev-mem/*");
      expect(gitignore1).toContain("!.dev-mem/shared.jsonl");

      // 2. Migration of legacy .dev-mem/ entry
      const legacyRoot = mkdtempSync(join(tmpdir(), "dm-sync-legacy-gi-"));
      try {
        writeFileSync(join(legacyRoot, ".gitignore"), "node_modules/\n.dev-mem/\ndist/\n", "utf8");
        ensureDevMemGitignore(legacyRoot);
        const migrated = readFileSync(join(legacyRoot, ".gitignore"), "utf8");
        expect(migrated).toContain(".dev-mem/*");
        expect(migrated).toContain("!.dev-mem/shared.jsonl");
        expect(migrated).not.toMatch(/^\.dev-mem\/\s*$/m);
      } finally {
        safeRm(legacyRoot);
      }
    } finally {
      safeRm(root);
    }
  });
});
