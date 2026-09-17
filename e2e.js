import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore } from "./dist/core/graph/index.js";
import { runCli } from "./dist/cli/index.js";
import { checkStaleness, checkContradictions } from "./dist/core/consistency/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testRepo = join(__dirname, "e2e-repo");

if (existsSync(testRepo)) {
  rmSync(testRepo, { recursive: true, force: true });
}
mkdirSync(testRepo, { recursive: true });
execSync("git init", { cwd: testRepo });
writeFileSync(join(testRepo, "test.txt"), "hello");
execSync("git add .", { cwd: testRepo });
execSync("git commit -m init", { cwd: testRepo });

// 1. Install dev-mem into test repo
console.log("=== 1. Installing dev-mem hooks ===");
const origCwd = process.cwd();
process.chdir(testRepo);
const installResult = await runCli(["install"]);
process.chdir(origCwd);

if (installResult.exitCode !== 0) {
  console.error("Install failed:", installResult.stderr);
  process.exit(1);
}
console.log("✅ Installed hooks into .claude/hooks/\n");

// 2. Seed graph with initial state:
// - A Decision
// - A FailedApproach for src/auth/verify.ts
// - A Decision that cites a temporary file src/deprecated.ts
console.log("=== 2. Seeding Initial Graph State ===");
const store = new GraphStore({ projectRoot: testRepo });

const decision1 = store.createNode({
  title: "Use Firebase Admin for server-side authentication",
  type: "Decision",
  evidence: {
    commit: "a1b2c3d4",
    files: ["src/auth/provider.ts"],
    confidence: 0.95,
    session_id: "sess_001",
    agent: "claude-code",
    timestamp: new Date(Date.now() - 86400000).toISOString(),
  },
});

const failedApproach = store.createNode({
  title: "Client-side token verification caused inconsistent server session state",
  type: "FailedApproach",
  content: "Client-side token verification led to desynced session states and token replay vulnerabilities.",
  evidence: {
    commit: "f1e2d3c4",
    files: ["src/auth/verify.ts"],
    confidence: 0.88,
    session_id: "sess_001",
    agent: "claude-code",
    timestamp: new Date(Date.now() - 43200000).toISOString(),
  },
});

// File that currently exists on disk
mkdirSync(join(testRepo, "src", "auth"), { recursive: true });
writeFileSync(join(testRepo, "src", "auth", "provider.ts"), "// auth provider implementation");

const tempFilePath = join(testRepo, "src", "deprecated.ts");
writeFileSync(tempFilePath, "// temporary deprecated module");

const fileSpecificNode = store.createNode({
  title: "Legacy auth shim in deprecated.ts",
  type: "Convention",
  evidence: {
    commit: "b9c8d7e6",
    files: ["src/deprecated.ts"],
    confidence: 0.90,
    session_id: "sess_001",
    agent: "claude-code",
    timestamp: new Date().toISOString(),
  },
});
store.close();
console.log("✅ Seeded 3 nodes (Decision, FailedApproach, Convention)\n");

// 3. Test Regression Intelligence: Mid-session re-attempt via PostToolUse
console.log("=== 3. Testing Regression Intelligence (Mid-Session PostToolUse) ===");
const postToolPayload = {
  hook_event_name: "PostToolUse",
  session_id: "sess_002",
  cwd: testRepo,
  tool_name: "Edit",
  tool_input: {
    file_path: "src/auth/verify.ts",
  },
  tool_response: {
    success: true,
  },
};

const postToolStdout = execSync("node .claude/hooks/dev-mem-posttooluse.js", {
  cwd: testRepo,
  input: JSON.stringify(postToolPayload),
  encoding: "utf-8",
});

console.log("PostToolUse Hook Stdout:\n" + postToolStdout.trim() + "\n");
const postToolParsed = JSON.parse(postToolStdout.trim());
const postToolContext = postToolParsed?.hookSpecificOutput?.additionalContext;

if (postToolContext && postToolContext.includes("<dev_mem_regression_warning>") && postToolContext.includes("Client-side token verification")) {
  console.log("✅ Regression Intelligence actively surfaced warning on file edit!");
} else {
  console.error("❌ Regression Intelligence failed to surface warning on PostToolUse.");
  process.exit(1);
}

// 4. Test Regression Intelligence: SessionStart with dirty files
console.log("\n=== 4. Testing Regression Intelligence + Retrieval at SessionStart ===");
// Create a dirty change in src/auth/verify.ts so git snapshot catches it
mkdirSync(join(testRepo, "src", "auth"), { recursive: true });
writeFileSync(join(testRepo, "src", "auth", "verify.ts"), "// re-attempting token verification");

const sessionStartPayload = {
  hook_event_name: "SessionStart",
  session_id: "sess_003",
  cwd: testRepo,
};

const sessionStartStdout = execSync("node .claude/hooks/dev-mem-sessionstart.js", {
  cwd: testRepo,
  input: JSON.stringify(sessionStartPayload),
  encoding: "utf-8",
});

console.log("SessionStart Hook Stdout:\n" + sessionStartStdout.trim() + "\n");
const sessionStartParsed = JSON.parse(sessionStartStdout.trim());
const sessionStartContext = sessionStartParsed?.hookSpecificOutput?.additionalContext;

if (sessionStartContext && sessionStartContext.includes("<dev_mem_regression_warning>") && sessionStartContext.includes("<dev_mem_context>")) {
  console.log("✅ SessionStart surfaced both Regression Warning and Budgeted Context!");
} else {
  console.error("❌ SessionStart missing expected regression warning or context.");
  process.exit(1);
}

// 5. Test Staleness Detection: Delete file cited by fileSpecificNode
console.log("\n=== 5. Testing Staleness Detection (§8.2) ===");
unlinkSync(tempFilePath);
console.log(`Deleted file: ${tempFilePath}`);

const stalenessResult = checkStaleness(testRepo);
console.log("Staleness Result:", stalenessResult);

const verifyStore = new GraphStore({ projectRoot: testRepo });
const updatedNode = verifyStore.getNode(fileSpecificNode.id);
verifyStore.close();

console.log(`Node "${updatedNode.title}" state: ${updatedNode.lifecycle_state}`);
if (updatedNode.lifecycle_state === "stale") {
  console.log("✅ Node successfully transitioned to 'stale' after file deletion!");
} else {
  console.error(`❌ Expected node state to be 'stale', got '${updatedNode.lifecycle_state}'`);
  process.exit(1);
}

// 6. Test Contradiction Detection (§8.2): Propose an opposing node
console.log("\n=== 6. Testing Contradiction Detection (§8.2) ===");
const contradictionStore = new GraphStore({ projectRoot: testRepo });
const conflictingNode = contradictionStore.createNode({
  title: "Avoid Firebase Admin — prefer self-hosted authentication",
  type: "Decision",
  evidence: {
    commit: "d4e5f6a7",
    files: ["src/auth/provider.ts"],
    confidence: 0.92,
    session_id: "sess_004",
    agent: "claude-code",
    timestamp: new Date().toISOString(),
  },
});
contradictionStore.close();

const contradictionResult = await checkContradictions(conflictingNode, testRepo);
console.log("Contradiction Result:", contradictionResult);

const edgeCheckStore = new GraphStore({ projectRoot: testRepo });
const edges = edgeCheckStore.listEdges();
edgeCheckStore.close();

const contradictsEdge = edges.find(
  (e) =>
    e.type === "contradicts" &&
    ((e.from_id === conflictingNode.id && e.to_id === decision1.id) ||
     (e.from_id === decision1.id && e.to_id === conflictingNode.id))
);

if (contradictsEdge) {
  console.log("✅ Contradiction detected and 'contradicts' edge created:", contradictsEdge);
} else {
  console.error("❌ Contradiction detection failed to create edge.");
  process.exit(1);
}

console.log("\n===========================================");
console.log("🎉 ALL MILESTONE 5 VERIFICATIONS PASSED! 🎉");
console.log("===========================================");
