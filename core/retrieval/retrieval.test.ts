import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  calculateRelevance,
  jaccard,
  tokenise,
  retrieveContext,
  generateInjectionString,
} from "./index.js";
import { GraphStore } from "../graph/index.js";
import type { KnowledgeNode } from "../graph/types.js";

// ─── Unit tests: tokenise + jaccard ──────────────────────────────────────────

describe("tokenise", () => {
  it("splits on non-word chars and lowercases", () => {
    const tokens = tokenise("Use Firebase Auth");
    expect(tokens.has("firebase")).toBe(true);
    expect(tokens.has("auth")).toBe(true);
  });

  it("drops tokens shorter than 3 chars", () => {
    const tokens = tokenise("a bb ccc dddd");
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("bb")).toBe(false);
    expect(tokens.has("ccc")).toBe(true);
    expect(tokens.has("dddd")).toBe(true);
  });

  it("drops stopwords", () => {
    const tokens = tokenise("use the same pattern for all endpoints");
    // "use", "the", "for", "all" are stopwords
    expect(tokens.has("use")).toBe(false);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("same")).toBe(true);
    expect(tokens.has("pattern")).toBe(true);
    expect(tokens.has("endpoints")).toBe(true);
  });

  it("splits file paths into tokens", () => {
    const tokens = tokenise("src/auth/session.ts");
    expect(tokens.has("src")).toBe(true);
    expect(tokens.has("auth")).toBe(true);
    expect(tokens.has("session")).toBe(true);
    // "ts" is 2 chars — filtered
    expect(tokens.has("ts")).toBe(false);
  });
});

describe("jaccard", () => {
  it("returns 1.0 for identical sets", () => {
    const s = new Set(["foo", "bar", "baz"]);
    expect(jaccard(s, s)).toBe(1.0);
  });

  it("returns 0.0 for disjoint sets", () => {
    expect(jaccard(new Set(["foo"]), new Set(["bar"]))).toBe(0.0);
  });

  it("returns 0.5 for half-overlap", () => {
    // {a,b} ∩ {b,c} = {b}, union = {a,b,c}, jaccard = 1/3 ≈ 0.333
    const j = jaccard(new Set(["a", "b"]), new Set(["b", "c"]));
    expect(j).toBeCloseTo(1 / 3);
  });

  it("returns 0 for two empty sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

// ─── Unit tests: calculateRelevance ──────────────────────────────────────────

function makeMinimalNode(overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id: "test-node",
    type: "Decision",
    title: "Use Firebase Auth for server-side authentication",
    content: "Switched to Firebase Admin SDK. Reason: it validates tokens server-side.",
    lifecycle_state: "observed",
    evidence: {
      commit: "abc1234",
      files: ["src/auth/session.ts", "src/auth/provider.ts"],
      session_id: "sess_1",
      agent: "claude-code",
      timestamp: new Date().toISOString(),
      confidence: 0.9,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("calculateRelevance", () => {
  it("returns 0.5 when no currentTask and no currentFiles", () => {
    const node = makeMinimalNode();
    expect(calculateRelevance(node, undefined, undefined)).toBe(0.5);
  });

  it("returns 0.5 when currentFiles is empty array", () => {
    const node = makeMinimalNode();
    expect(calculateRelevance(node, undefined, [])).toBe(0.5);
  });

  it("scores high when currentTask shares key terms with node title", () => {
    const node = makeMinimalNode();
    // "auth" appears in both title and task
    const score = calculateRelevance(node, "Implement server-side authentication with Firebase", undefined);
    expect(score).toBeGreaterThan(0.2);
  });

  it("scores low when currentTask shares no terms with node", () => {
    const node = makeMinimalNode();
    const score = calculateRelevance(node, "Add input validation to REST endpoints", undefined);
    // The node is about auth/Firebase; the task is about validation/REST
    expect(score).toBeLessThan(0.2);
  });

  it("scores high on file-path fallback when currentFiles overlap node evidence.files", () => {
    const node = makeMinimalNode();
    // Exact file match → high overlap
    const score = calculateRelevance(node, undefined, ["src/auth/session.ts"]);
    expect(score).toBeGreaterThan(0.3);
  });

  it("scores low on file-path fallback when currentFiles don't overlap", () => {
    const node = makeMinimalNode();
    const score = calculateRelevance(node, undefined, ["docs/architecture.md"]);
    expect(score).toBeLessThan(0.2);
  });

  it("currentTask takes precedence over currentFiles when both provided", () => {
    const node = makeMinimalNode();
    // Task text matches auth; files are unrelated — relevance should still be high
    const withTask = calculateRelevance(
      node,
      "Fix Firebase authentication token validation",
      ["docs/conventions.md"],  // unrelated file
    );
    // file-only score would be low; task-based score should be higher
    const fileOnly = calculateRelevance(node, undefined, ["docs/conventions.md"]);
    expect(withTask).toBeGreaterThan(fileOnly);
  });

  it("relevance is symmetric — node about REST gets low score for auth task", () => {
    const restNode = makeMinimalNode({
      title: "REST endpoints follow GET/POST/PUT/DELETE pattern",
      content: "All CRUD routes defined in src/server.js",
      evidence: {
        commit: "abc1234",
        files: ["src/server.js"],
        session_id: "sess_2",
        agent: "claude-code",
        timestamp: new Date().toISOString(),
        confidence: 0.85,
      },
    });
    const authScore = calculateRelevance(restNode, "Implement Firebase Auth token validation", undefined);
    const restScore = calculateRelevance(restNode, "Add REST endpoints for task CRUD operations", undefined);
    expect(restScore).toBeGreaterThan(authScore);
  });
});

// ─── Integration test: retrieveContext filters by relevance ──────────────────

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@dev-mem.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("retrieveContext — relevance filtering", () => {
  let testDir: string;
  let store: GraphStore;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "dev-mem-retrieval-test-"));
    initGitRepo(testDir);
    store = new GraphStore({ projectRoot: testDir });
  });

  afterEach(() => {
    store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  const baseEvidence = {
    commit: "abc1234",
    session_id: "sess_1",
    agent: "claude-code" as const,
    timestamp: new Date().toISOString(),
    confidence: 0.9,
    symbols: [],
  };

  it("returns node relevant to currentTask and suppresses unrelated node under tight budget", () => {
    // Node A: about auth
    store.createNode({
      type: "Decision",
      title: "Use Firebase Auth for server-side authentication",
      content: "Firebase Admin validates JWT tokens server-side.",
      evidence: { ...baseEvidence, files: ["src/auth/session.ts"] },
    });

    // Node B: about validation (unrelated to auth task)
    store.createNode({
      type: "Convention",
      title: "Input validation uses manual typeof checks",
      content: "No external validation library. Manual checks only.",
      evidence: { ...baseEvidence, files: ["src/server.js"] },
    });

    store.close();

    // Task is about auth — node A should rank above node B
    const results = retrieveContext({
      projectRoot: testDir,
      budgetTokens: 2000,
      currentTask: "Implement server-side Firebase authentication",
      currentFiles: ["src/auth/session.ts"],
    });

    // Re-open for cleanup
    store = new GraphStore({ projectRoot: testDir });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain("Firebase");
  });

  it("under a very tight budget, injects only the highest-scoring relevant node", () => {
    store.createNode({
      type: "Decision",
      title: "Use Firebase Auth for server-side authentication",
      content: "Firebase Admin validates JWT tokens server-side.",
      evidence: { ...baseEvidence, files: ["src/auth/session.ts"] },
    });
    store.createNode({
      type: "Convention",
      title: "Input validation uses manual typeof checks without libraries",
      content: "No joi, no zod. typeof checks only for required fields.",
      evidence: { ...baseEvidence, files: ["src/server.js"] },
    });
    store.createNode({
      type: "OpenIssue",
      title: "OAuth E2E tests still fail in CI environment",
      content: "All OAuth flows fail when run in GitHub Actions. Needs investigation.",
      evidence: { ...baseEvidence, files: ["tests/oauth.spec.ts"] },
    });

    store.close();

    // Tight budget: each formatted node costs ~35 tokens; budget of 40 fits exactly one
    const results = retrieveContext({
      projectRoot: testDir,
      budgetTokens: 40,   // fits exactly one ~35-token node
      currentTask: "Fix Firebase authentication token validation bug",
      currentFiles: ["src/auth/session.ts"],
    });

    store = new GraphStore({ projectRoot: testDir });

    expect(results.length).toBe(1);
    expect(results[0].title).toContain("Firebase");
  });

  it("injects nothing when no nodes exist", () => {
    store.close();
    const results = retrieveContext({
      projectRoot: testDir,
      budgetTokens: 2000,
      currentTask: "Add authentication",
    });
    store = new GraphStore({ projectRoot: testDir });
    expect(results).toEqual([]);
    expect(generateInjectionString(results)).toBe("");
  });
});
